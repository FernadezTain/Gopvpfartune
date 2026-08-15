"""
API-сервер для сайта "Колесо шансов" — адаптирован под Vercel serverless.

Работает В ПАРЕ с основным telegram-ботом (bot.py/main.py), который живёт
ОТДЕЛЬНО на своём хостинге (Deploy-f) — Vercel не умеет держать
долгоживущие процессы (long polling), поэтому бот остаётся там, где был.

Общее состояние (баланс шансов) синхронизируется через общий Postgres —
оба процесса подключаются к одному DATABASE_URL.

Деплой на Vercel:
    Файл должен лежать по пути  api/index.py  в корне репозитория.
    Vercel сам находит объект `app` и запускает его как ASGI-приложение —
    отдельно поднимать uvicorn не нужно, локальный запуск через
    `uvicorn api.index:app --reload` тоже работает для разработки.

Переменные окружения (задаются в Vercel Dashboard -> Settings ->
Environment Variables, НЕ через export/.env):
    BOT_TOKEN       — токен бота (тот же, что в Deploy-f)
    DATABASE_URL    — строка подключения к Supabase (Session pooler)
    ALLOWED_ORIGIN  — https://gopvp-fartune.vercel.app (или "*" на время теста)
"""

import os
import time
import math
import uuid
import random
import secrets
import logging
from contextlib import contextmanager
from typing import Optional

import psycopg2
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from telegram import Bot
from telegram.error import TelegramError

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("api_server")

BOT_TOKEN = os.environ.get("BOT_TOKEN")
if not BOT_TOKEN:
    raise RuntimeError("Не задана переменная окружения BOT_TOKEN")

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "Не задана переменная окружения DATABASE_URL — строка подключения к общему Postgres."
    )

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

CODE_TTL_SECONDS = 5 * 60
SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 дней
CODE_RESEND_COOLDOWN = 30  # сек между повторными кодами

MIN_BET = 1
BET_STEP = 1
MAX_BET = 100

# label, multiplier (None -> бонусный шанс, не денежный множитель), вес (промилле, сумма = 1000)
WHEEL_SECTIONS = [
    {"label": "x0",        "multiplier": 0.0,  "kind": "mult", "weight": 320},
    {"label": "x1",        "multiplier": 1.0,  "kind": "mult", "weight": 250},
    {"label": "x0.5",      "multiplier": 0.5,  "kind": "mult", "weight": 150},
    {"label": "x1.5",      "multiplier": 1.5,  "kind": "mult", "weight": 100},
    {"label": "x2",        "multiplier": 2.0,  "kind": "mult", "weight": 90},
    {"label": "🎁 +1",     "multiplier": None, "kind": "bonus_chance", "weight": 60},
    {"label": "x3",        "multiplier": 3.0,  "kind": "mult", "weight": 25},
    {"label": "x5",        "multiplier": 5.0,  "kind": "mult", "weight": 5},
]
assert sum(s["weight"] for s in WHEEL_SECTIONS) == 1000

bot = Bot(token=BOT_TOKEN)

app = FastAPI(title="Gift Chance Wheel API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN] if ALLOWED_ORIGIN != "*" else ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def db():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# На serverless процесс может быть "тёплым" между вызовами (Vercel
# переиспользует инстанс, если он не "заснул"), поэтому имеет смысл не
# гонять CREATE TABLE IF NOT EXISTS на каждый запрос — только на первый
# вызов в рамках живущего инстанса. На холодном старте отработает снова,
# но это заведомо редкий случай, а не каждый /api/auth/request-code.
_tables_ready = False


def ensure_tables():
    global _tables_ready
    if _tables_ready:
        return
    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS user_chances (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                balance INTEGER DEFAULT 0
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS auth_codes (
                user_id BIGINT PRIMARY KEY,
                code TEXT,
                expires_at BIGINT,
                last_sent_at BIGINT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id BIGINT,
                username TEXT,
                created_at BIGINT,
                expires_at BIGINT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS spins (
                id SERIAL PRIMARY KEY,
                user_id BIGINT,
                bet INTEGER,
                label TEXT,
                multiplier REAL,
                payout INTEGER,
                balance_after INTEGER,
                created_at BIGINT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS game_rounds (
                game_round_id UUID PRIMARY KEY,
                user_id BIGINT,
                game_type TEXT,
                bet INTEGER,
                result_label TEXT,
                payout INTEGER,
                balance_change INTEGER,
                balance_after INTEGER,
                created_at TIMESTAMPTZ DEFAULT now()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS aviator_rounds (
                round_id UUID PRIMARY KEY,
                user_id BIGINT,
                bet INTEGER,
                status TEXT DEFAULT 'flying',
                crash_point REAL,
                started_flying_at TIMESTAMPTZ DEFAULT now(),
                crashed_at TIMESTAMPTZ,
                cashout_multiplier REAL,
                payout INTEGER
            )
        """)
        cur.close()
    _tables_ready = True


@app.on_event("startup")
async def startup():
    ensure_tables()
    log.info("API-сервер запущен, БД: %s", DATABASE_URL.split("@")[-1])


# ---------- модели ----------

class RequestCodeBody(BaseModel):
    telegram_id: int


class VerifyCodeBody(BaseModel):
    telegram_id: int
    code: str = Field(min_length=4, max_length=8)


class SpinBody(BaseModel):
    bet: int = Field(ge=MIN_BET, le=MAX_BET)


# ---------- авторизация ----------

def require_session(conn, token: str) -> dict:
    """Проверяет сессию в рамках УЖЕ открытого соединения — так эндпоинты,
    которым нужна и авторизация, и своя работа с базой (spin, history, me),
    делают это одним соединением на запрос, а не двумя (раньше сначала
    current_user открывал своё соединение, потом эндпоинт — своё)."""
    cur = conn.cursor()
    cur.execute(
        "SELECT token, user_id, username, expires_at FROM sessions WHERE token = %s", (token,)
    )
    row = cur.fetchone()
    cur.close()
    if not row or row[3] < time.time():
        raise HTTPException(status_code=401, detail="Сессия недействительна, войдите снова")
    return {"token": row[0], "user_id": row[1], "username": row[2]}


async def bearer_token(authorization: Optional[str] = Header(default=None)) -> str:
    """Достаёт токен из заголовка — без похода в базу. Саму сессию
    проверяет require_session() внутри соединения конкретного эндпоинта."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Нет токена авторизации")
    return authorization.split(" ", 1)[1].strip()


@app.post("/api/auth/request-code")
async def request_code(body: RequestCodeBody):
    user_id = body.telegram_id
    now = int(time.time())

    code = f"{secrets.randbelow(1_000_000):06d}"
    with db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT last_sent_at FROM auth_codes WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        if row and now - row[0] < CODE_RESEND_COOLDOWN:
            wait = CODE_RESEND_COOLDOWN - (now - row[0])
            cur.close()
            raise HTTPException(status_code=429, detail=f"Подождите {wait} сек. перед повторной отправкой кода")

        cur.execute("""
            INSERT INTO auth_codes (user_id, code, expires_at, last_sent_at) VALUES (%s, %s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET code = excluded.code,
                expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at
        """, (user_id, code, now + CODE_TTL_SECONDS, now))
        cur.close()

    try:
        await bot.send_message(
            chat_id=user_id,
            text=(
                f"🔐 Код для входа на сайт: <b>{code}</b>\n\n"
                f"Никому не сообщайте этот код. Он действует {CODE_TTL_SECONDS // 60} минут."
            ),
            parse_mode="HTML",
        )
    except TelegramError as e:
        raise HTTPException(
            status_code=400,
            detail="Не удалось отправить код. Сначала напишите боту /start в Telegram, затем повторите попытку.",
        ) from e

    return {"ok": True, "message": "Код отправлен в Telegram"}


@app.post("/api/auth/verify")
async def verify_code(body: VerifyCodeBody):
    user_id = body.telegram_id
    token = secrets.token_urlsafe(32)
    now = int(time.time())

    with db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT code, expires_at FROM auth_codes WHERE user_id = %s", (user_id,))
        row = cur.fetchone()

        if not row:
            cur.close()
            raise HTTPException(status_code=400, detail="Сначала запросите код")
        stored_code, expires_at = row
        if time.time() > expires_at:
            cur.close()
            raise HTTPException(status_code=400, detail="Код истёк, запросите новый")
        if not secrets.compare_digest(stored_code, body.code.strip()):
            cur.close()
            raise HTTPException(status_code=400, detail="Неверный код")

        cur.execute("DELETE FROM auth_codes WHERE user_id = %s", (user_id,))
        cur.execute("SELECT username, balance FROM user_chances WHERE user_id = %s", (user_id,))
        u = cur.fetchone()
        username = u[0] if u and u[0] else str(user_id)
        balance = u[1] if u else 0

        cur.execute(
            "INSERT INTO sessions (token, user_id, username, created_at, expires_at) VALUES (%s, %s, %s, %s, %s)",
            (token, user_id, username, now, now + SESSION_TTL_SECONDS),
        )
        cur.close()

    return {"ok": True, "token": token, "telegram_id": user_id, "username": username, "balance": balance}


# ---------- профиль / баланс ----------

@app.get("/api/me")
async def me(token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        cur = conn.cursor()
        cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user["user_id"],))
        row = cur.fetchone()
        cur.close()
    balance = row[0] if row else 0

    return {
        "telegram_id": user["user_id"],
        "username": user["username"],
        "balance": balance,
        "min_bet": MIN_BET,
        "bet_step": BET_STEP,
        "max_bet": MAX_BET,
        "sections": [
            {"label": s["label"], "weight": s["weight"], "kind": s["kind"], "multiplier": s["multiplier"]}
            for s in WHEEL_SECTIONS
        ],
    }


@app.get("/api/history")
async def history(token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        cur = conn.cursor()
        cur.execute("""
            SELECT bet, label, payout, balance_after, created_at
            FROM spins WHERE user_id = %s ORDER BY id DESC LIMIT 15
        """, (user["user_id"],))
        rows = cur.fetchall()
        cur.close()
    return {"spins": [
        {"bet": r[0], "label": r[1], "payout": r[2], "balance_after": r[3], "created_at": r[4]} for r in rows
    ]}


# ---------- вращение колеса ----------

def roll_section() -> tuple[int, dict]:
    roll = random.randint(1, 1000)
    acc = 0
    for idx, section in enumerate(WHEEL_SECTIONS):
        acc += section["weight"]
        if roll <= acc:
            return idx, section
    return len(WHEEL_SECTIONS) - 1, WHEEL_SECTIONS[-1]


@app.post("/api/spin")
async def spin(body: SpinBody, token: str = Depends(bearer_token)):
    bet = body.bet
    if bet != MIN_BET and (bet - MIN_BET) % BET_STEP != 0:
        raise HTTPException(status_code=400, detail=f"Некорректная ставка")

    index, section = roll_section()
    if section["kind"] == "bonus_chance":
        payout = bet + 1  # ставка возвращается + бонусный шанс
    else:
        payout = int(bet * section["multiplier"])
    net = payout - bet  # итоговое изменение баланса за один спин

    # Всё действие — проверка сессии, списание ставки, начисление выигрыша,
    # чтение нового баланса, запись в историю — одно соединение и одна
    # транзакция, а не пять отдельных, как было раньше.
    with db() as conn:
        user = require_session(conn, token)
        user_id, username = user["user_id"], user["username"]

        cur = conn.cursor()
        cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        balance = row[0] if row else 0
        if balance < bet:
            cur.close()
            raise HTTPException(status_code=400, detail="Недостаточно шансов на балансе")

        new_balance = balance + net
        cur.execute("""
            INSERT INTO user_chances (user_id, username, balance) VALUES (%s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET
                balance = %s,
                username = excluded.username
        """, (user_id, username, new_balance, new_balance))

        cur.execute("""
            INSERT INTO spins (user_id, bet, label, multiplier, payout, balance_after, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (user_id, bet, section["label"], section.get("multiplier"), payout, new_balance, int(time.time())))

        # Дублируем в общую таблицу истории — её читает профиль
        # (детализация по всем играм: колесо, самолётик и т.д.)
        cur.execute("""
            INSERT INTO game_rounds
                (user_id, game_type, bet, result_label, payout, balance_change, balance_after)
            VALUES (%s, 'wheel', %s, %s, %s, %s, %s)
        """, (user_id, bet, section["label"], payout, net, new_balance))
        cur.close()

    return {
        "ok": True,
        "section_index": index,
        "label": section["label"],
        "payout": payout,
        "bet": bet,
        "new_balance": new_balance,
    }


@app.get("/api/games/history")
async def games_history(token: str = Depends(bearer_token)):
    """Единая детализация по ВСЕМ играм (колесо, самолётик, ...) для профиля."""
    with db() as conn:
        user = require_session(conn, token)
        cur = conn.cursor()
        cur.execute("""
            SELECT game_round_id, game_type, bet, result_label, payout, balance_change, created_at
            FROM game_rounds WHERE user_id = %s ORDER BY created_at DESC LIMIT 100
        """, (user["user_id"],))
        rows = cur.fetchall()
        cur.close()
    return {"rounds": [
        {
            "game_round_id": str(r[0]),
            "game_type": r[1],
            "bet": r[2],
            "result_label": r[3],
            "payout": r[4],
            "balance_change": r[5],
            "created_at": r[6],
        } for r in rows
    ]}


@app.get("/api/health")
async def health():
    return {"ok": True, "time": int(time.time())}


# ---------- самолётик (Aviator) ----------
#
# Раунд у каждого игрока свой личный: crash_point роллится ОДИН раз при
# ставке и сразу пишется в БД (секретный — не отдаётся клиенту до краша).
# Дальше мультипликатор — чистая функция времени: mult = exp(RATE * t).
# Никакого фонового процесса не нужно — на serverless (Vercel) он бы всё
# равно не пережил между вызовами. Вместо этого — "ленивое" завершение:
# при каждом обращении к раунду сначала проверяем, не истекло ли уже
# время полёта, и если да — фиксируем крах тут же, до остального.

AVI_GROWTH_RATE = 0.16
AVI_MIN_BET = 1
AVI_MAX_BET = 500


class AviatorBetBody(BaseModel):
    bet: int = Field(ge=AVI_MIN_BET, le=AVI_MAX_BET)


def avi_roll_crash_point() -> float:
    r = random.random()
    if r < 0.04:
        return 1.00
    return min(round(0.96 / (1 - r), 2), 500.0)


def avi_crash_after_seconds(crash_point: float) -> float:
    return math.log(crash_point) / AVI_GROWTH_RATE


def avi_current_multiplier(started_flying_at, crash_point: float) -> float:
    elapsed = time.time() - started_flying_at.timestamp()
    return round(math.exp(AVI_GROWTH_RATE * elapsed), 2)


def avi_settle_if_expired(cur, round_id, user_id, bet: int, started_flying_at, crash_point: float):
    """Если время до crash_point уже прошло, а раунд всё ещё 'flying' —
    фиксирует крах и списывает ставку как проигрыш. Вызывается перед любой
    операцией с раундом, чтобы не полагаться на фоновый таймер."""
    elapsed = time.time() - started_flying_at.timestamp()
    if elapsed < avi_crash_after_seconds(crash_point):
        return False  # ещё летит

    cur.execute(
        "UPDATE aviator_rounds SET status='crashed', crashed_at=now() WHERE round_id=%s AND status='flying'",
        (round_id,),
    )
    if cur.rowcount:  # именно мы закрыли раунд первыми (не гонка с cashout)
        cur.execute("SELECT balance FROM user_chances WHERE user_id=%s", (user_id,))
        row = cur.fetchone()
        balance_after = row[0] if row else 0
        cur.execute(
            """INSERT INTO game_rounds
               (game_round_id, user_id, game_type, bet, result_label, payout, balance_change, balance_after)
               VALUES (%s, %s, 'aviator', %s, %s, 0, %s, %s)""",
            (round_id, user_id, bet, f"{crash_point}x", -bet, balance_after),
        )
    return True


@app.post("/api/aviator/bet")
async def aviator_bet(body: AviatorBetBody, token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id, username = user["user_id"], user["username"]
        cur = conn.cursor()

        cur.execute(
            "SELECT round_id, bet, status, started_flying_at, crash_point FROM aviator_rounds "
            "WHERE user_id=%s AND status='flying' ORDER BY started_flying_at DESC LIMIT 1",
            (user_id,),
        )
        active = cur.fetchone()
        if active:
            avi_settle_if_expired(cur, active[0], user_id, active[1], active[3], active[4])
            cur.execute("SELECT status FROM aviator_rounds WHERE round_id=%s", (active[0],))
            still_flying = cur.fetchone()[0] == "flying"
            if still_flying:
                cur.close()
                raise HTTPException(status_code=400, detail="У вас уже есть активный полёт")

        cur.execute("SELECT balance FROM user_chances WHERE user_id=%s", (user_id,))
        row = cur.fetchone()
        balance = row[0] if row else 0
        if balance < body.bet:
            cur.close()
            raise HTTPException(status_code=400, detail="Недостаточно шансов на балансе")

        new_balance = balance - body.bet
        cur.execute("UPDATE user_chances SET balance=%s WHERE user_id=%s", (new_balance, user_id))

        crash_point = avi_roll_crash_point()
        round_id = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO aviator_rounds (round_id, user_id, bet, status, crash_point, started_flying_at)
               VALUES (%s, %s, %s, 'flying', %s, now())""",
            (round_id, user_id, body.bet, crash_point),
        )
        cur.close()

    return {"ok": True, "round_id": round_id, "new_balance": new_balance}


@app.get("/api/aviator/state")
async def aviator_state(token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        cur = conn.cursor()
        cur.execute(
            "SELECT round_id, bet, status, started_flying_at, crash_point FROM aviator_rounds "
            "WHERE user_id=%s ORDER BY started_flying_at DESC LIMIT 1",
            (user["user_id"],),
        )
        row = cur.fetchone()
        if not row:
            cur.close()
            return {"has_round": False}

        round_id, bet, status, started_flying_at, crash_point = row
        if status == "flying":
            avi_settle_if_expired(cur, round_id, user["user_id"], bet, started_flying_at, crash_point)
            cur.execute("SELECT status FROM aviator_rounds WHERE round_id=%s", (round_id,))
            status = cur.fetchone()[0]
        cur.close()

    if status != "flying":
        return {"has_round": False}

    return {
        "has_round": True,
        "round_id": str(round_id),
        "status": status,
        "bet": bet,
        "multiplier": avi_current_multiplier(started_flying_at, crash_point),
    }


@app.post("/api/aviator/cashout")
async def aviator_cashout(token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]
        cur = conn.cursor()

        cur.execute(
            "SELECT round_id, bet, status, started_flying_at, crash_point FROM aviator_rounds "
            "WHERE user_id=%s ORDER BY started_flying_at DESC LIMIT 1",
            (user_id,),
        )
        row = cur.fetchone()
        if not row:
            cur.close()
            raise HTTPException(status_code=400, detail="Активного полёта нет")

        round_id, bet, status, started_flying_at, crash_point = row
        if status == "flying":
            avi_settle_if_expired(cur, round_id, user_id, bet, started_flying_at, crash_point)
            cur.execute("SELECT status FROM aviator_rounds WHERE round_id=%s", (round_id,))
            status = cur.fetchone()[0]

        if status != "flying":
            cur.close()
            raise HTTPException(status_code=400, detail="Самолётик уже разбился")

        current_mult = avi_current_multiplier(started_flying_at, crash_point)
        payout = int(bet * current_mult)

        cur.execute(
            "UPDATE aviator_rounds SET status='cashed_out', cashout_multiplier=%s, payout=%s WHERE round_id=%s AND status='flying'",
            (current_mult, payout, round_id),
        )
        if not cur.rowcount:
            # проиграли гонку с ленивым завершением по времени — кто-то (следующий запрос) успел раньше
            cur.close()
            raise HTTPException(status_code=400, detail="Самолётик уже разбился")

        cur.execute("SELECT balance FROM user_chances WHERE user_id=%s", (user_id,))
        balance = cur.fetchone()[0]
        new_balance = balance + payout
        cur.execute("UPDATE user_chances SET balance=%s WHERE user_id=%s", (new_balance, user_id))
        cur.execute(
            """INSERT INTO game_rounds
               (game_round_id, user_id, game_type, bet, result_label, payout, balance_change, balance_after)
               VALUES (%s, %s, 'aviator', %s, %s, %s, %s, %s)""",
            (round_id, user_id, bet, f"{current_mult}x", payout, payout - bet, new_balance),
        )
        cur.close()

    return {"ok": True, "multiplier": current_mult, "payout": payout, "new_balance": new_balance}
