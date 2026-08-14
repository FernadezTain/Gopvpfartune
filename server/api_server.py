"""
API-сервер для сайта "Колесо шансов".

Работает В ПАРЕ с основным telegram-ботом (bot.py), но живёт на СВОЁМ,
отдельном хосте. Общее состояние (баланс шансов) синхронизируется через
общий Postgres — оба процесса подключаются к одному DATABASE_URL, каждый
со своего сервера. SQLite тут не подходит, т.к. это локальный файл, а не
сетевая база.

Frontend (site/) хостится на Vercel/GitHub Pages и стучится сюда по HTTPS.

Установка:
    pip install fastapi "uvicorn[standard]" python-telegram-bot psycopg2-binary

Запуск:
    export BOT_TOKEN="8874363455:AAF..."
    export DATABASE_URL="postgresql://user:pass@host:5432/dbname?sslmode=require"
    export ALLOWED_ORIGIN="https://your-site.vercel.app"
    uvicorn api_server:app --host 0.0.0.0 --port 8000
"""

import os
import time
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

BOT_TOKEN = os.environ.get("BOT_TOKEN", "8874363455:AAF_FYrak6k6BxNWDvxvdUp-0EGw-kJ0YGU")

# Строка подключения к общему Postgres — ДОЛЖНА совпадать с DATABASE_URL,
# который использует bot.py на своём хосте.
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "Не задана переменная окружения DATABASE_URL — строка подключения к общему Postgres."
    )

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

CODE_TTL_SECONDS = 5 * 60
SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 дней
CODE_RESEND_COOLDOWN = 30  # сек между повторными кодами

MIN_BET = 5
BET_STEP = 5
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


def ensure_tables():
    with db() as conn:
        cur = conn.cursor()
        # эти таблицы должны уже существовать (создаёт бот), но на случай
        # первого запуска api_server раньше бота — создадим тоже
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
        cur.close()


def get_balance(user_id: int) -> int:
    with db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        cur.close()
    return row[0] if row else 0


def set_balance_delta(user_id: int, username: str, delta: int):
    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO user_chances (user_id, username, balance) VALUES (%s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET
                balance = user_chances.balance + excluded.balance,
                username = excluded.username
        """, (user_id, username, delta))
        cur.close()


def try_spend(user_id: int, username: str, amount: int) -> bool:
    with db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        balance = row[0] if row else 0
        if balance < amount:
            cur.close()
            return False
        cur.execute("""
            INSERT INTO user_chances (user_id, username, balance) VALUES (%s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET
                balance = user_chances.balance - %s,
                username = excluded.username
        """, (user_id, username, balance - amount, amount))
        cur.close()
    return True


@app.on_event("startup")
async def startup():
    ensure_tables()
    log.info("API-сервер запущен, БД: %s", DB_PATH)


# ---------- модели ----------

class RequestCodeBody(BaseModel):
    telegram_id: int


class VerifyCodeBody(BaseModel):
    telegram_id: int
    code: str = Field(min_length=4, max_length=8)


class SpinBody(BaseModel):
    bet: int = Field(ge=MIN_BET, le=MAX_BET)


# ---------- авторизация ----------

def create_session(user_id: int, username: str) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with db() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO sessions (token, user_id, username, created_at, expires_at) VALUES (%s, %s, %s, %s, %s)",
            (token, user_id, username, now, now + SESSION_TTL_SECONDS),
        )
        cur.close()
    return token


def get_session(token: str) -> Optional[dict]:
    with db() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT token, user_id, username, expires_at FROM sessions WHERE token = %s", (token,)
        )
        row = cur.fetchone()
        cur.close()
    if not row:
        return None
    if row[3] < time.time():
        return None
    return {"token": row[0], "user_id": row[1], "username": row[2]}


async def current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Нет токена авторизации")
    token = authorization.split(" ", 1)[1].strip()
    session = get_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Сессия недействительна, войдите снова")
    return session


@app.post("/api/auth/request-code")
async def request_code(body: RequestCodeBody):
    ensure_tables()
    user_id = body.telegram_id
    now = int(time.time())

    with db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT last_sent_at FROM auth_codes WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        cur.close()
        if row and now - row[0] < CODE_RESEND_COOLDOWN:
            wait = CODE_RESEND_COOLDOWN - (now - row[0])
            raise HTTPException(status_code=429, detail=f"Подождите {wait} сек. перед повторной отправкой кода")

    code = f"{secrets.randbelow(1_000_000):06d}"
    with db() as conn:
        cur = conn.cursor()
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
    with db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT code, expires_at FROM auth_codes WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        cur.close()

    if not row:
        raise HTTPException(status_code=400, detail="Сначала запросите код")
    stored_code, expires_at = row
    if time.time() > expires_at:
        raise HTTPException(status_code=400, detail="Код истёк, запросите новый")
    if not secrets.compare_digest(stored_code, body.code.strip()):
        raise HTTPException(status_code=400, detail="Неверный код")

    with db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM auth_codes WHERE user_id = %s", (user_id,))
        cur.execute("SELECT username FROM user_chances WHERE user_id = %s", (user_id,))
        u = cur.fetchone()
        cur.close()
    username = u[0] if u and u[0] else str(user_id)

    token = create_session(user_id, username)
    return {"ok": True, "token": token, "telegram_id": user_id, "username": username, "balance": get_balance(user_id)}


# ---------- профиль / баланс ----------

@app.get("/api/me")
async def me(user=Depends(current_user)):
    return {
        "telegram_id": user["user_id"],
        "username": user["username"],
        "balance": get_balance(user["user_id"]),
        "min_bet": MIN_BET,
        "bet_step": BET_STEP,
        "max_bet": MAX_BET,
        "sections": [
            {"label": s["label"], "weight": s["weight"], "kind": s["kind"], "multiplier": s["multiplier"]}
            for s in WHEEL_SECTIONS
        ],
    }


@app.get("/api/history")
async def history(user=Depends(current_user)):
    with db() as conn:
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
async def spin(body: SpinBody, user=Depends(current_user)):
    user_id = user["user_id"]
    username = user["username"]
    bet = body.bet

    if bet % BET_STEP != 0:
        raise HTTPException(status_code=400, detail=f"Ставка должна быть кратна {BET_STEP}")

    if not try_spend(user_id, username, bet):
        raise HTTPException(status_code=400, detail="Недостаточно шансов на балансе")

    index, section = roll_section()

    if section["kind"] == "bonus_chance":
        payout = bet + 1  # ставка возвращается + бонусный шанс
    else:
        payout = int(bet * section["multiplier"])

    if payout > 0:
        set_balance_delta(user_id, username, payout)

    new_balance = get_balance(user_id)

    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO spins (user_id, bet, label, multiplier, payout, balance_after, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (user_id, bet, section["label"], section.get("multiplier"), payout, new_balance, int(time.time())))
        cur.close()

    return {
        "ok": True,
        "section_index": index,
        "label": section["label"],
        "payout": payout,
        "bet": bet,
        "new_balance": new_balance,
    }


@app.get("/api/health")
async def health():
    return {"ok": True, "time": int(time.time())}
