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
import json
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

# Секрет для служебных /api/admin/* ручек (выдача предметов в инвентарь
# и т.п.) — задаётся в Vercel Dashboard. Если не задан, admin-ручки просто
# отвечают 503, ничего не ломая на обычных пользовательских эндпоинтах.
ADMIN_SECRET = os.environ.get("ADMIN_SECRET")

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

# ---------- содержимое кейсов (сиды по умолчанию) ----------
#
# Раньше кейс был один, зашитый прямо в код (CASE_COST/CASE_ITEMS). Теперь
# кейсов может быть сколько угодно — они лежат в таблицах `cases` (сама
# карточка кейса: ключ, имя, цена, иконка) и `case_cash_items` (денежные
# призы ЭТОГО кейса, аналог старого CASE_ITEMS, но с привязкой к case_key).
# Предметные призы (NFT/подарки/Stars) по-прежнему настраиваются через
# case_pool -> shop_items — там тоже теперь используется case_key.
#
# DEFAULT_CASES — это только НАЧАЛЬНЫЙ сид, вставляется в БД один раз при
# первом запуске (см. ensure_tables), если таблица `cases` ещё пустая.
# Дальше все правки (добавить кейс, поменять цену/призы) делаются прямо в
# Supabase Table Editor — редеплой кода для этого не нужен.
DEFAULT_CASES = [
    {
        "case_key": "gopvp_green",
        "name": "gopvp_green",
        "cost": 250,
        "icon": "case_icon/Gopvp_greencase.png",
        "badge": "Новое",
        "sort_order": 1,
        "cash_items": [
            {"label": "Пусто",   "value": 0,  "weight": 350, "rarity": "common"},
            {"label": "10 GP",   "value": 10, "weight": 250, "rarity": "common"},
            {"label": "20 GP",   "value": 20, "weight": 180, "rarity": "uncommon"},
            {"label": "35 GP",   "value": 35, "weight": 120, "rarity": "rare"},
            {"label": "60 GP",   "value": 60, "weight": 60,  "rarity": "epic"},
            {"label": "100 GP",  "value": 100, "weight": 30, "rarity": "legendary"},
            {"label": "250 GP",  "value": 250, "weight": 9,  "rarity": "mythic"},
            {"label": "500 GP",  "value": 500, "weight": 1,  "rarity": "mythic"},
        ],
    },
    {
        "case_key": "gopvp_beggar",
        "name": "Золотой кейс",
        "cost": 100,
        "icon": "case_icon/Gopvp_beggarcase.png",
        "badge": "Новое",
        "sort_order": 2,
        "cash_items": [
            {"label": "Пусто",   "value": 0,   "weight": 300, "rarity": "common"},
            {"label": "50 GP",   "value": 50,  "weight": 250, "rarity": "uncommon"},
            {"label": "90 GP",   "value": 90,  "weight": 180, "rarity": "rare"},
            {"label": "150 GP",  "value": 150, "weight": 120, "rarity": "epic"},
            {"label": "300 GP",  "value": 300, "weight": 90,  "rarity": "legendary"},
            {"label": "600 GP",  "value": 600, "weight": 45,  "rarity": "mythic"},
            {"label": "1200 GP", "value": 1200, "weight": 15, "rarity": "mythic"},
        ],
    },
]

# ---------- каталог предметов (сиды по умолчанию) ----------
#
# shop_items — единственный источник правды о том, ЧТО такое каждый
# предмет. Сайт никогда не хранит и не передаёт "картинку" или "цену"
# предмета сам по себе — только item_id, а фактические данные (тип,
# коллекция, модель, фон, символ, иконки, цены) сервер всегда достаёт
# из этой таблицы и уже готовым объектом отдаёт на фронт. Ровно так же
# это устроено при выпадении предмета из кейса (build_case_pool делает
# JOIN case_pool -> shop_items) и при выдаче через /api/admin/inventory/grant
# (там просто SELECT ... FROM shop_items WHERE id = %s).
#
# DEFAULT_SHOP_ITEMS — сид с примерами трёх типов предметов (ваши же
# примеры: NFT, Gift, Stars), вставляется один раз при первом запуске,
# если таблица shop_items ещё пустая. Дальше реальные NFT/подарки
# добавляются просто строками в Supabase Table Editor — сайт подхватит
# их автоматически, без единой правки кода.
#
# icon_png/icon_gif — если одно из полей пустое, применяется другое
# (см. правило в pickIconFor* на фронте). Ниже стоят ЗАГЛУШКИ-ссылки —
# их нужно заменить на реальные URL картинок (например, ссылки на файлы,
# загруженные в Supabase Storage) через Table Editor.
DEFAULT_SHOP_ITEMS = [
    {
        "key": "sample_nft_snake_box_fuchsia",  # только для сидирования case_pool, в БД не хранится
        "type": "nft",
        "collection": "Snake Box",
        "model": "Fuchsia",
        "background": "Aquamarine",
        "symbol": "Pumpkin Coach",
        "icon_png": "https://your-cdn.example.com/nft/snake_box_fuchsia.png",
        "icon_gif": None,
        "background_png": None,
        "price_stars": 400,
        "price_gp": 500,
    },
    {
        "key": "sample_gift_teddy",
        "type": "gift",
        "collection": "Teddy",
        "model": None,
        "background": None,
        "symbol": None,
        "icon_png": "https://your-cdn.example.com/gift/teddy.png",
        "icon_gif": None,
        "background_png": None,
        "price_stars": 15,
        "price_gp": 13,
    },
    {
        "key": "sample_stars",
        "type": "stars",
        "collection": None,
        "model": None,
        "background": None,
        "symbol": None,
        "icon_png": "https://your-cdn.example.com/stars/stars.png",
        "icon_gif": None,
        "background_png": None,
        "price_stars": 15,
        "price_gp": 13,
    },
]

# Каких примерных предметов из DEFAULT_SHOP_ITEMS и с каким весом добавить
# в пул выпадения кейса при первом сидировании — просто чтобы сразу после
# деплоя было видно, что предметы реально выпадают из кейса, а не только
# GP. Ключ ("key") соответствует полю "key" в DEFAULT_SHOP_ITEMS выше.
DEFAULT_CASE_POOL = {
    "gopvp_gold": [
        {"key": "sample_nft_snake_box_fuchsia", "weight": 5, "rarity": "mythic"},
        {"key": "sample_gift_teddy", "weight": 40, "rarity": "rare"},
    ],
}

# Используется, чтобы получить читаемый label для предмета из shop_items,
# когда он выпадает в кейсе (см. build_case_pool ниже).
ITEM_TYPE_LABELS = {"nft": "NFT", "gift": "Подарок", "stars": "Stars"}


def _item_display_label(type_: str, collection, model, symbol) -> str:
    t = (type_ or "").lower()
    if t == "nft":
        return model or symbol or collection or "NFT"
    if t == "gift":
        return collection or "Подарок"
    return "Stars"


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
            CREATE TABLE IF NOT EXISTS blackjack_hands (
                hand_id UUID PRIMARY KEY,
                user_id BIGINT,
                bet INTEGER,
                status TEXT DEFAULT 'active',
                deck JSONB,
                player_cards JSONB,
                dealer_cards JSONB,
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

        # ---------- Инвентарь (NFT / подарки / Stars) ----------
        #
        # shop_items — каталог "витрины": сюда картинки и параметры
        # предметов добавляются вручную через Supabase Table Editor (или
        # позже — отдельной админкой). Именно эту таблицу имел в виду
        # запрос "все картинки будут в Supabase в специальной таблице".
        #
        # Поля соответствуют примерам из ТЗ:
        #   type            — 'nft' | 'gift' | 'stars'
        #   collection      — например "Snake Box" / "Teddy"
        #   model           — например "Fuchsia" (для NFT)
        #   background      — CSS-совместимое имя цвета, например "Aquamarine",
        #                     "Tomato" — эти слова сами по себе валидные CSS-цвета,
        #                     поэтому фронт может использовать их напрямую.
        #   symbol          — например "Pumpkin Coach"
        #   icon_png/icon_gif — если одно из полей пустое, используется другое
        #   background_png  — картинка-подложка карточки (необязательна)
        #   price_stars / price_gp — цены в двух валютах приложения
        cur.execute("""
            CREATE TABLE IF NOT EXISTS shop_items (
                id SERIAL PRIMARY KEY,
                type TEXT NOT NULL,
                collection TEXT,
                model TEXT,
                background TEXT,
                symbol TEXT,
                icon_png TEXT,
                icon_gif TEXT,
                background_png TEXT,
                price_stars INTEGER NOT NULL DEFAULT 0,
                price_gp INTEGER NOT NULL DEFAULT 0,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)

        # user_inventory — то, чем реально владеет игрок. Поля предмета
        # снимаются "снимком" (копируются) в момент выдачи — так обмен и
        # история не ломаются, даже если каталожную запись потом изменят
        # или удалят в Supabase.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS user_inventory (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                item_id INTEGER REFERENCES shop_items(id) ON DELETE SET NULL,
                type TEXT NOT NULL,
                collection TEXT,
                model TEXT,
                background TEXT,
                symbol TEXT,
                icon_png TEXT,
                icon_gif TEXT,
                background_png TEXT,
                price_stars INTEGER NOT NULL DEFAULT 0,
                price_gp INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'admin',
                status TEXT NOT NULL DEFAULT 'owned',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_user_inventory_user ON user_inventory (user_id, status)")

        # case_pool — какие ПРЕДМЕТЫ (не шансы) могут выпасть из кейса.
        # Денежные призы (CASE_ITEMS) остаются захардкожены в коде как и
        # были, а вот выпадение NFT/подарков/Stars из shop_items настраивается
        # прямо здесь: чтобы добавить предмет в дроп кейса, admin добавляет
        # строку в эту таблицу (через Supabase Table Editor) с item_id
        # (id из shop_items) и весом. Вес — в тех же "промилле", что и у
        # CASE_ITEMS: суммарный вес пула = сумма весов CASE_ITEMS (1000) +
        # сумма весов активных строк отсюда, т.е. чем больше вес строки,
        # тем реальнее шанс выпадения (общий тираж роли пересчитывается
        # каждый раз, привязки к ровно 1000 больше нет).
        # cases — список кейсов, которые видит пользователь на экране
        # "Кейсы". Раньше был один кейс, зашитый в коде, теперь строка в
        # этой таблице = отдельная карточка кейса на фронте. Добавить
        # новый кейс = добавить строку сюда (+ призы в case_cash_items /
        # case_pool с тем же case_key) — без изменений кода.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cases (
                case_key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                cost INTEGER NOT NULL,
                icon TEXT,
                badge TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)

        # case_cash_items — денежные призы (GP) КОНКРЕТНОГО кейса. Аналог
        # старого захардкоженного CASE_ITEMS, но теперь у каждого кейса
        # свой набор — сумма весов внутри одного case_key может быть любой,
        # шанс выпадения считается относительно суммы весов всего пула
        # этого кейса (cash + item), см. build_case_pool/roll_case_entry.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS case_cash_items (
                id SERIAL PRIMARY KEY,
                case_key TEXT NOT NULL REFERENCES cases(case_key) ON DELETE CASCADE,
                label TEXT NOT NULL,
                value INTEGER NOT NULL,
                weight INTEGER NOT NULL,
                rarity TEXT NOT NULL DEFAULT 'common',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_case_cash_items_case ON case_cash_items (case_key)")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS case_pool (
                id SERIAL PRIMARY KEY,
                case_key TEXT NOT NULL REFERENCES cases(case_key) ON DELETE CASCADE,
                item_id INTEGER NOT NULL REFERENCES shop_items(id) ON DELETE CASCADE,
                weight INTEGER NOT NULL,
                rarity TEXT NOT NULL DEFAULT 'legendary',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_case_pool_case ON case_pool (case_key)")

        # Сидим дефолтные кейсы ТОЛЬКО если таблица cases ещё пустая —
        # чтобы повторные холодные старты и редеплои не затирали то, что
        # админ уже поменял руками в Supabase.
        cur.execute("SELECT COUNT(*) FROM cases")
        if cur.fetchone()[0] == 0:
            for c in DEFAULT_CASES:
                cur.execute("""
                    INSERT INTO cases (case_key, name, cost, icon, badge, sort_order)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (case_key) DO NOTHING
                """, (c["case_key"], c["name"], c["cost"], c["icon"], c["badge"], c["sort_order"]))
                for cash in c["cash_items"]:
                    cur.execute("""
                        INSERT INTO case_cash_items (case_key, label, value, weight, rarity)
                        VALUES (%s, %s, %s, %s, %s)
                    """, (c["case_key"], cash["label"], cash["value"], cash["weight"], cash["rarity"]))

        # Сидим примеры каталога предметов (NFT / Gift / Stars) ТОЛЬКО если
        # shop_items ещё пустая — дальше это уже полностью зона Supabase
        # Table Editor, код их не трогает и не перезаписывает.
        cur.execute("SELECT COUNT(*) FROM shop_items")
        if cur.fetchone()[0] == 0:
            key_to_id = {}
            for it in DEFAULT_SHOP_ITEMS:
                cur.execute("""
                    INSERT INTO shop_items
                        (type, collection, model, background, symbol,
                         icon_png, icon_gif, background_png, price_stars, price_gp)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                """, (it["type"], it["collection"], it["model"], it["background"], it["symbol"],
                      it["icon_png"], it["icon_gif"], it["background_png"],
                      it["price_stars"], it["price_gp"]))
                key_to_id[it["key"]] = cur.fetchone()[0]

            for case_key, entries in DEFAULT_CASE_POOL.items():
                for entry in entries:
                    item_id = key_to_id.get(entry["key"])
                    if item_id is None:
                        continue
                    cur.execute("""
                        INSERT INTO case_pool (case_key, item_id, weight, rarity)
                        VALUES (%s, %s, %s, %s)
                    """, (case_key, item_id, entry["weight"], entry["rarity"]))

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


class BlackjackBetBody(BaseModel):
    bet: int = Field(ge=MIN_BET, le=MAX_BET)


class BlackjackHandBody(BaseModel):
    hand_id: str


class InventoryExchangeBody(BaseModel):
    currency: str = Field(pattern="^(gp|stars)$")


class AdminGrantBody(BaseModel):
    telegram_id: int
    item_id: int


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


def get_case_or_404(cur, case_key: str) -> dict:
    cur.execute("""
        SELECT case_key, name, cost, icon, badge FROM cases
        WHERE case_key = %s AND is_active = TRUE
    """, (case_key,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Кейс не найден")
    return {"case_key": row[0], "name": row[1], "cost": row[2], "icon": row[3], "badge": row[4]}


def build_case_pool(cur, case_key: str) -> list:
    """Собирает единый пул ОДНОГО кейса (case_key): денежные призы
    (case_cash_items) + предметы (case_pool -> shop_items). Оба источника
    настраиваются в Supabase, код можно не трогать. Порядок ДЕТЕРМИНИРОВАН
    (сначала денежные призы по id, потом предметы по id) — фронт получает
    точно такой же список и по нему же строит ленту прокрутки, поэтому
    item_index из /api/cases/{case_key}/open обязан указывать на ту же
    позицию, что и в /api/cases/{case_key}."""
    pool = []

    cur.execute("""
        SELECT label, value, weight, rarity FROM case_cash_items
        WHERE case_key = %s AND is_active = TRUE
        ORDER BY id ASC
    """, (case_key,))
    for label, value, weight, rarity in cur.fetchall():
        pool.append({
            "kind": "cash",
            "label": label,
            "value": value,
            "weight": weight,
            "rarity": rarity,
        })

    cur.execute("""
        SELECT cp.weight, cp.rarity, si.id, si.type, si.collection, si.model,
               si.background, si.symbol, si.icon_png, si.icon_gif, si.background_png,
               si.price_stars, si.price_gp
        FROM case_pool cp
        JOIN shop_items si ON si.id = cp.item_id
        WHERE cp.case_key = %s AND cp.is_active = TRUE AND si.is_active = TRUE
        ORDER BY cp.id ASC
    """, (case_key,))
    for row in cur.fetchall():
        (weight, rarity, item_id, type_, collection, model, background, symbol,
         icon_png, icon_gif, background_png, price_stars, price_gp) = row
        pool.append({
            "kind": "item",
            "label": _item_display_label(type_, collection, model, symbol),
            "weight": weight,
            "rarity": rarity,
            "item": {
                "item_id": item_id,
                "type": type_,
                "collection": collection,
                "model": model,
                "background": background,
                "symbol": symbol,
                "icon_png": icon_png,
                "icon_gif": icon_gif,
                "background_png": background_png,
                "price_stars": price_stars,
                "price_gp": price_gp,
            },
        })
    return pool


def roll_case_entry(pool: list) -> tuple[int, dict]:
    total_weight = sum(p["weight"] for p in pool)
    roll = random.randint(1, total_weight)
    acc = 0
    for idx, entry in enumerate(pool):
        acc += entry["weight"]
        if roll <= acc:
            return idx, entry
    return len(pool) - 1, pool[-1]


@app.post("/api/spin")
async def spin(body: SpinBody, token: str = Depends(bearer_token)):
    bet = body.bet
    if bet != MIN_BET and (bet - MIN_BET) % BET_STEP != 0:
        raise HTTPException(status_code=400, detail=f"Некорректная ставка")

    index, section = roll_section()
    if section["kind"] == "bonus_chance":
        payout = bet + 1  # ставка возвращается + бонусный шанс
    else:
        # ВАЖНО: было int(bet * multiplier) — это ОБРЕЗАНИЕ (floor), а не
        # округление. Из-за него на x0.5/x1.5 при нечётных ставках игрок
        # систематически недополучал выигрыш: например bet=1 на x1.5 давал
        # int(1.5)=1 → net=0 (визуально "секция выигрышная, а по факту ничего"),
        # а bet=3 на x0.5 давал int(1.5)=1 вместо честных 1.5→2. Округление
        # вверх-от-половины (half-up) убирает этот перекос и всегда даёт
        # математически ожидаемый результат для игрока.
        payout = math.floor(bet * section["multiplier"] + 0.5)
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
            raise HTTPException(status_code=400, detail="Недостаточно GP на балансе")

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


@app.get("/api/cases")
async def list_cases(token: str = Depends(bearer_token)):
    """Список ВСЕХ активных кейсов для экрана "Кейсы" — просто карточки
    (ключ/имя/цена/иконка), без содержимого. Содержимое конкретного кейса
    подгружается отдельно через /api/cases/{case_key}, когда пользователь
    открывает экран этого кейса."""
    with db() as conn:
        require_session(conn, token)
        cur = conn.cursor()
        cur.execute("""
            SELECT case_key, name, cost, icon, badge FROM cases
            WHERE is_active = TRUE
            ORDER BY sort_order ASC, case_key ASC
        """)
        rows = cur.fetchall()
        cur.close()

    return {
        "cases": [
            {"case_key": r[0], "name": r[1], "cost": r[2], "icon": r[3], "badge": r[4]}
            for r in rows
        ]
    }


@app.get("/api/cases/{case_key}")
async def get_case_detail(case_key: str, token: str = Depends(bearer_token)):
    """Содержимое ОДНОГО кейса (цена + пул призов) — используется на
    экране открытия конкретного кейса."""
    with db() as conn:
        require_session(conn, token)
        cur = conn.cursor()
        case = get_case_or_404(cur, case_key)
        pool = build_case_pool(cur, case_key)
        cur.close()

    items = []
    for p in pool:
        entry = {"kind": p["kind"], "label": p["label"], "weight": p["weight"], "rarity": p["rarity"]}
        if p["kind"] == "cash":
            entry["value"] = p["value"]
        else:
            entry["item"] = p["item"]
        items.append(entry)

    return {
        "case_key": case["case_key"],
        "name": case["name"],
        "icon": case["icon"],
        "cost": case["cost"],
        "items": items,
    }


@app.post("/api/cases/{case_key}/open")
async def open_case(case_key: str, token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id, username = user["user_id"], user["username"]
        cur = conn.cursor()

        case = get_case_or_404(cur, case_key)
        case_cost = case["cost"]

        pool = build_case_pool(cur, case_key)
        if not pool:
            cur.close()
            raise HTTPException(status_code=500, detail="У кейса не настроены призы")
        index, entry = roll_case_entry(pool)

        cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        balance = row[0] if row else 0
        if balance < case_cost:
            cur.close()
            raise HTTPException(status_code=400, detail="Недостаточно GP на балансе")

        if entry["kind"] == "cash":
            net = entry["value"] - case_cost
            new_balance = balance + net
            cur.execute("""
                INSERT INTO user_chances (user_id, username, balance) VALUES (%s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    balance = %s,
                    username = excluded.username
            """, (user_id, username, new_balance, new_balance))

            cur.execute("""
                INSERT INTO game_rounds
                    (user_id, game_type, bet, result_label, payout, balance_change, balance_after)
                VALUES (%s, 'case', %s, %s, %s, %s, %s)
            """, (user_id, case_cost, entry["label"], entry["value"], net, new_balance))
            cur.close()

            return {
                "ok": True,
                "kind": "cash",
                "item_index": index,
                "label": entry["label"],
                "value": entry["value"],
                "rarity": entry["rarity"],
                "cost": case_cost,
                "new_balance": new_balance,
            }

        # entry["kind"] == "item" — приз уходит не деньгами, а предметом
        # в инвентарь; ставка (стоимость кейса) всё равно списывается.
        item = entry["item"]
        net = -case_cost
        new_balance = balance + net
        cur.execute("""
            INSERT INTO user_chances (user_id, username, balance) VALUES (%s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET
                balance = %s,
                username = excluded.username
        """, (user_id, username, new_balance, new_balance))

        cur.execute("""
            INSERT INTO user_inventory
                (user_id, item_id, type, collection, model, background, symbol,
                 icon_png, icon_gif, background_png, price_stars, price_gp, source, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'case', 'owned')
            RETURNING id, created_at
        """, (user_id, item["item_id"], item["type"], item["collection"], item["model"],
              item["background"], item["symbol"], item["icon_png"], item["icon_gif"],
              item["background_png"], item["price_stars"], item["price_gp"]))
        inv_id, created_at = cur.fetchone()

        cur.execute("""
            INSERT INTO game_rounds
                (user_id, game_type, bet, result_label, payout, balance_change, balance_after)
            VALUES (%s, 'case', %s, %s, 0, %s, %s)
        """, (user_id, case_cost, entry["label"], net, new_balance))
        cur.close()

        new_item = {
            "id": inv_id,
            "item_id": item["item_id"],
            "type": item["type"],
            "collection": item["collection"],
            "model": item["model"],
            "background": item["background"],
            "symbol": item["symbol"],
            "icon_png": item["icon_png"],
            "icon_gif": item["icon_gif"],
            "background_png": item["background_png"],
            "price_stars": item["price_stars"],
            "price_gp": item["price_gp"],
            "status": "owned",
            "acquired_at": created_at,
        }

        return {
            "ok": True,
            "kind": "item",
            "item_index": index,
            "label": entry["label"],
            "rarity": entry["rarity"],
            "cost": case_cost,
            "new_balance": new_balance,
            "new_item": new_item,
        }


def _serialize_inventory_row(row) -> dict:
    (inv_id, item_id, type_, collection, model, background, symbol,
     icon_png, icon_gif, background_png, price_stars, price_gp,
     status, created_at) = row
    return {
        "id": inv_id,
        "item_id": item_id,
        "type": type_,
        "collection": collection,
        "model": model,
        "background": background,
        "symbol": symbol,
        "icon_png": icon_png,
        "icon_gif": icon_gif,
        "background_png": background_png,
        "price_stars": price_stars,
        "price_gp": price_gp,
        "status": status,
        "acquired_at": created_at,
    }


INVENTORY_COLUMNS = """
    id, item_id, type, collection, model, background, symbol,
    icon_png, icon_gif, background_png, price_stars, price_gp,
    status, created_at
"""


@app.get("/api/inventory")
async def get_inventory(token: str = Depends(bearer_token)):
    """Инвентарь текущего игрока — только предметы в статусе 'owned'
    (обменянные/выведенные из витрины не показываются)."""
    with db() as conn:
        user = require_session(conn, token)
        cur = conn.cursor()
        cur.execute(f"""
            SELECT {INVENTORY_COLUMNS} FROM user_inventory
            WHERE user_id = %s AND status = 'owned'
            ORDER BY id DESC
        """, (user["user_id"],))
        rows = cur.fetchall()
        cur.close()
    return {"items": [_serialize_inventory_row(r) for r in rows]}


@app.post("/api/inventory/{inventory_id}/exchange")
async def exchange_inventory_item(inventory_id: int, body: InventoryExchangeBody, token: str = Depends(bearer_token)):
    """Обмен предмета:
      - currency == 'gp'    -> предмет списывается, price_gp зачисляется на баланс сразу
      - currency == 'stars' -> предмет списывается, взамен в инвентарь добавляется
                                предмет типа 'stars' (иконка берётся из каталожного
                                шаблона type='stars', если такой есть, иначе — из
                                иконки самого обмениваемого предмета), стоимость
                                которого равна price_stars исходного предмета.
    """
    with db() as conn:
        user = require_session(conn, token)
        user_id, username = user["user_id"], user["username"]
        cur = conn.cursor()

        cur.execute(f"""
            SELECT {INVENTORY_COLUMNS} FROM user_inventory
            WHERE id = %s AND user_id = %s AND status = 'owned'
            FOR UPDATE
        """, (inventory_id, user_id))
        row = cur.fetchone()
        if not row:
            cur.close()
            raise HTTPException(status_code=404, detail="Предмет не найден в инвентаре")
        item = _serialize_inventory_row(row)

        if body.currency == "gp":
            cur.execute("UPDATE user_inventory SET status = 'exchanged_gp' WHERE id = %s", (inventory_id,))

            cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
            bal_row = cur.fetchone()
            balance = bal_row[0] if bal_row else 0
            new_balance = balance + item["price_gp"]
            cur.execute("""
                INSERT INTO user_chances (user_id, username, balance) VALUES (%s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    balance = %s,
                    username = excluded.username
            """, (user_id, username, new_balance, new_balance))

            cur.execute("""
                INSERT INTO game_rounds
                    (user_id, game_type, bet, result_label, payout, balance_change, balance_after)
                VALUES (%s, 'exchange', 0, %s, %s, %s, %s)
            """, (user_id, f"Обмен: {item['collection'] or item['type']} → GP",
                  item["price_gp"], item["price_gp"], new_balance))
            cur.close()
            return {"ok": True, "currency": "gp", "new_balance": new_balance, "credited": item["price_gp"]}

        # currency == "stars"
        cur.execute("""
            SELECT id, icon_png, icon_gif, background_png FROM shop_items
            WHERE lower(type) = 'stars' AND is_active = TRUE
            ORDER BY id ASC LIMIT 1
        """)
        template = cur.fetchone()
        template_item_id = template[0] if template else None
        icon_png = template[1] if template else item["icon_png"]
        icon_gif = template[2] if template else item["icon_gif"]
        background_png = template[3] if template else item["background_png"]

        cur.execute("UPDATE user_inventory SET status = 'exchanged_stars' WHERE id = %s", (inventory_id,))

        cur.execute("""
            INSERT INTO user_inventory
                (user_id, item_id, type, collection, model, background, symbol,
                 icon_png, icon_gif, background_png, price_stars, price_gp, source, status)
            VALUES (%s, %s, 'stars', NULL, NULL, NULL, NULL, %s, %s, %s, %s, %s, 'exchange', 'owned')
            RETURNING id, created_at
        """, (user_id, template_item_id, icon_png, icon_gif, background_png,
              item["price_stars"], item["price_gp"]))
        new_id, created_at = cur.fetchone()

        cur.execute("""
            INSERT INTO game_rounds
                (user_id, game_type, bet, result_label, payout, balance_change, balance_after)
            VALUES (%s, 'exchange', 0, %s, 0, 0,
                (SELECT balance FROM user_chances WHERE user_id = %s))
        """, (user_id, f"Обмен: {item['collection'] or item['type']} → Stars", user_id))
        cur.close()

        new_item = {
            "id": new_id,
            "item_id": template_item_id,
            "type": "stars",
            "collection": None,
            "model": None,
            "background": None,
            "symbol": None,
            "icon_png": icon_png,
            "icon_gif": icon_gif,
            "background_png": background_png,
            "price_stars": item["price_stars"],
            "price_gp": item["price_gp"],
            "status": "owned",
            "acquired_at": created_at,
        }
        return {"ok": True, "currency": "stars", "new_item": new_item}


@app.post("/api/inventory/{inventory_id}/claim")
async def claim_inventory_item(inventory_id: int, token: str = Depends(bearer_token)):
    """"Получить" предмет — помечает его как запрошенный к выводу.
    Фактическая передача подарка/звёзд происходит вне сайта (поддержка/бот),
    здесь только фиксируем заявку, чтобы предмет не обменяли повторно."""
    with db() as conn:
        user = require_session(conn, token)
        cur = conn.cursor()
        cur.execute("""
            UPDATE user_inventory SET status = 'claim_requested'
            WHERE id = %s AND user_id = %s AND status = 'owned'
            RETURNING id
        """, (inventory_id, user["user_id"]))
        row = cur.fetchone()
        cur.close()
    if not row:
        raise HTTPException(status_code=404, detail="Предмет не найден в инвентаре")
    return {"ok": True}


def _require_admin(secret: Optional[str]):
    if not ADMIN_SECRET:
        raise HTTPException(status_code=503, detail="Admin-функции не настроены (ADMIN_SECRET не задан)")
    if not secret or secret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="Неверный admin-секрет")


@app.post("/api/admin/inventory/grant")
async def admin_grant_item(body: AdminGrantBody, x_admin_secret: Optional[str] = Header(default=None)):
    """Служебная ручка для выдачи предмета из каталога shop_items конкретному
    игроку (по telegram_id). Вызывается с заголовком X-Admin-Secret."""
    _require_admin(x_admin_secret)
    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT type, collection, model, background, symbol,
                   icon_png, icon_gif, background_png, price_stars, price_gp
            FROM shop_items WHERE id = %s AND is_active = TRUE
        """, (body.item_id,))
        item = cur.fetchone()
        if not item:
            cur.close()
            raise HTTPException(status_code=404, detail="Предмет каталога не найден")
        cur.execute("""
            INSERT INTO user_inventory
                (user_id, item_id, type, collection, model, background, symbol,
                 icon_png, icon_gif, background_png, price_stars, price_gp, source, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'admin', 'owned')
            RETURNING id
        """, (body.telegram_id, body.item_id, *item))
        new_id = cur.fetchone()[0]
        cur.close()
    return {"ok": True, "inventory_id": new_id}


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


@app.get("/api/games/recent")
async def games_recent(
    token: str = Depends(bearer_token),
    game_type: Optional[str] = None,
):
    """Последние 5 игр ВСЕХ пользователей. По умолчанию — по всем играм
    сразу; если передан ?game_type=wheel или ?game_type=aviator — только
    по этой игре (так у каждой игры своя лента, а не общая на двоих)."""
    with db() as conn:
        require_session(conn, token)
        cur = conn.cursor()
        if game_type:
            cur.execute("""
                SELECT
                    COALESCE(u.username, g.user_id::text) AS username,
                    g.game_type,
                    g.bet,
                    g.result_label,
                    g.payout,
                    g.balance_change,
                    g.created_at
                FROM game_rounds g
                LEFT JOIN user_chances u ON u.user_id = g.user_id
                WHERE g.game_type = %s
                ORDER BY g.created_at DESC
                LIMIT 5
            """, (game_type,))
        else:
            cur.execute("""
                SELECT
                    COALESCE(u.username, g.user_id::text) AS username,
                    g.game_type,
                    g.bet,
                    g.result_label,
                    g.payout,
                    g.balance_change,
                    g.created_at
                FROM game_rounds g
                LEFT JOIN user_chances u ON u.user_id = g.user_id
                ORDER BY g.created_at DESC
                LIMIT 5
            """)
        rows = cur.fetchall()
        cur.close()
    return {"games": [
        {
            "username": r[0],
            "game_type": r[1],
            "bet": r[2],
            "result_label": r[3],
            "payout": r[4],
            "balance_change": r[5],
            "created_at": r[6].isoformat() if r[6] else None,
        } for r in rows
    ]}


@app.get("/api/health")
async def health():
    return {"ok": True, "time": int(time.time())}


## ---------- самолётик (Aviator) ----------

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
    multiplier = math.exp(AVI_GROWTH_RATE * elapsed)

    return round(min(multiplier, crash_point), 2)


def avi_get_user_active_bet(cur, user_id):
    """
    Возвращает активную ставку пользователя вместе с данными раунда.
    Новая схема:
        aviator_rounds = общий раунд
        aviator_bets   = ставка пользователя
    """
    cur.execute("""
        SELECT
            r.round_id,
            r.status,
            r.started_flying_at,
            r.crash_point,
            b.bet_id,
            b.bet,
            b.status,
            b.cashout_multiplier,
            b.payout
        FROM aviator_bets b
        JOIN aviator_rounds r
            ON r.round_id = b.round_id
        WHERE b.user_id = %s
          AND b.status = 'pending'
          AND r.status = 'flying'
        ORDER BY b.created_at DESC
        LIMIT 1
    """, (user_id,))

    return cur.fetchone()


def avi_settle_if_expired(cur, round_id, user_id, bet_id, bet,
                          started_flying_at, crash_point):
    """
    Если самолётик уже должен был разбиться —
    закрываем раунд и проигрываем ставку пользователя.
    """

    if not started_flying_at or crash_point is None:
        return False

    elapsed = time.time() - started_flying_at.timestamp()

    if elapsed < avi_crash_after_seconds(crash_point):
        return False

    # Закрываем общий раунд.
    cur.execute("""
        UPDATE aviator_rounds
        SET status = 'crashed',
            crashed_at = now()
        WHERE round_id = %s
          AND status = 'flying'
    """, (round_id,))

    round_closed = cur.rowcount > 0

    # В любом случае помечаем конкретную ставку проигранной,
    # если она всё ещё pending.
    cur.execute("""
        UPDATE aviator_bets
        SET status = 'lost',
            payout = 0
        WHERE bet_id = %s
          AND status = 'pending'
    """, (bet_id,))

    bet_closed = cur.rowcount > 0

    if bet_closed:
        cur.execute("""
            SELECT balance
            FROM user_chances
            WHERE user_id = %s
        """, (user_id,))

        row = cur.fetchone()
        balance_after = row[0] if row else 0

        cur.execute("""
            INSERT INTO game_rounds
                (
                    game_round_id,
                    user_id,
                    game_type,
                    bet,
                    result_label,
                    payout,
                    balance_change,
                    balance_after
                )
            VALUES
                (%s, %s, 'aviator', %s, %s, 0, %s, %s)
        """, (
            str(uuid.uuid4()),
            user_id,
            bet,
            f"{crash_point}x",
            -bet,
            balance_after
        ))

    return round_closed or bet_closed


@app.post("/api/aviator/bet")
async def aviator_bet(
    body: AviatorBetBody,
    token: str = Depends(bearer_token)
):

    
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]
        username = user["username"]

        cur = conn.cursor()

        # --------------------------------------------------
        # 1. Проверяем, нет ли уже активной ставки пользователя
        # --------------------------------------------------

        active = avi_get_user_active_bet(cur, user_id)

        if active:
            (
                round_id,
                status,
                started_flying_at,
                crash_point,
                bet_id,
                old_bet,
                bet_status,
                cashout_multiplier,
                payout,
            ) = active

            avi_settle_if_expired(
                cur,
                round_id,
                user_id,
                bet_id,
                old_bet,
                started_flying_at,
                crash_point,
            )

            # Проверяем ещё раз.
            active = avi_get_user_active_bet(cur, user_id)

            if active:
                cur.close()
                raise HTTPException(
                    status_code=400,
                    detail="У вас уже есть активная ставка"
                )

        # --------------------------------------------------
        # 2. Раунд приватный — новая ставка всегда начинает свой
        #    собственный полёт с 1.00x, а не подсаживается к чужому/
        #    предыдущему раунду, который мог ещё лететь после кэшаута.
        # --------------------------------------------------

        round_id = str(uuid.uuid4())
        crash_point = avi_roll_crash_point()

        cur.execute("""
            INSERT INTO aviator_rounds
                (
                    round_id,
                    status,
                    crash_point,
                    started_flying_at
                )
            VALUES
                (%s, 'flying', %s, now())
        """, (round_id, crash_point))

        cur.execute("""
            SELECT
                round_id,
                status,
                started_flying_at,
                crash_point
            FROM aviator_rounds
            WHERE round_id = %s
        """, (round_id,))

        round_row = cur.fetchone()
        round_id, round_status, started_flying_at, crash_point = round_row

        # --------------------------------------------------
        # 4. Проверяем баланс
        # --------------------------------------------------

        cur.execute("""
            SELECT balance
            FROM user_chances
            WHERE user_id = %s
        """, (user_id,))

        row = cur.fetchone()
        balance = row[0] if row else 0

        if balance < body.bet:
            cur.close()
            raise HTTPException(
                status_code=400,
                detail="Недостаточно GP на балансе"
            )

        # --------------------------------------------------
        # 5. Списываем ставку
        # --------------------------------------------------

        new_balance = balance - body.bet

        cur.execute("""
            UPDATE user_chances
            SET balance = %s
            WHERE user_id = %s
        """, (new_balance, user_id))

        # --------------------------------------------------
        # 6. Создаём ставку пользователя
        # --------------------------------------------------

        bet_id = str(uuid.uuid4())

        cur.execute("""
            INSERT INTO aviator_bets
                (
                    bet_id,
                    round_id,
                    user_id,
                    username,
                    bet,
                    status,
                    payout
                )
            VALUES
                (%s, %s, %s, %s, %s, 'pending', 0)
        """, (
            bet_id,
            round_id,
            user_id,
            username,
            body.bet
        ))

        cur.close()

    return {
        "ok": True,
        "round_id": str(round_id),
        "bet_id": str(bet_id),
        "bet": body.bet,
        "new_balance": new_balance,
        # раунд общий — к моменту, когда ответ дойдёт до клиента, самолётик
        # мог уже какое-то время лететь (другой игрок стартовал раньше,
        # либо просто сетевая задержка). Отдаём реальный множитель на
        # момент ответа, чтобы фронт синхронизировал локальный таймер
        # так же, как он это делает в onEnter().
        "multiplier": avi_current_multiplier(started_flying_at, crash_point),
        "started_flying_at": started_flying_at.timestamp(),
    }


@app.get("/api/aviator/state")
async def aviator_state(token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]

        cur = conn.cursor()

        active = avi_get_user_active_bet(cur, user_id)

        if not active:
            cur.close()
            return {"has_round": False}

        (
            round_id,
            status,
            started_flying_at,
            crash_point,
            bet_id,
            bet,
            bet_status,
            cashout_multiplier,
            payout,
        ) = active

        # Проверяем, не наступил ли crash.
        avi_settle_if_expired(
            cur,
            round_id,
            user_id,
            bet_id,
            bet,
            started_flying_at,
            crash_point,
        )

        # Получаем ставку ещё раз после возможного crash.
        active = avi_get_user_active_bet(cur, user_id)

        cur.close()

        if not active:
            return {"has_round": False}

        (
            round_id,
            status,
            started_flying_at,
            crash_point,
            bet_id,
            bet,
            bet_status,
            cashout_multiplier,
            payout,
        ) = active

    return {
        "has_round": True,
        "round_id": str(round_id),
        "bet_id": str(bet_id),
        "status": status,
        "bet": bet,
        "multiplier": avi_current_multiplier(
            started_flying_at,
            crash_point
        ),
        # Сколько секунд раунд уже летит на момент этого запроса. Если это
        # заметно больше, чем реально мог пройти в текущей сессии клиента
        # (пара секунд после клика "Поставить"), — это, скорее всего,
        # "зомби"-раунд, оставшийся от предыдущей ставки, чей кэшаут не
        # дошёл/не был подтверждён (обрыв связи, закрытая вкладка и т.п.),
        # а не только что начатый полёт. Фронт использует это, чтобы не
        # молча продолжать такой раунд, а явно предупредить игрока.
        "flying_seconds": round(time.time() - started_flying_at.timestamp(), 2),
    }


@app.post("/api/aviator/cashout")
async def aviator_cashout(token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]

        cur = conn.cursor()

        # --------------------------------------------------
        # 1. Получаем активную ставку
        # --------------------------------------------------

        active = avi_get_user_active_bet(cur, user_id)

        if not active:
            cur.close()
            raise HTTPException(
                status_code=400,
                detail="Активного полёта нет"
            )

        (
            round_id,
            status,
            started_flying_at,
            crash_point,
            bet_id,
            bet,
            bet_status,
            cashout_multiplier,
            old_payout,
        ) = active

        # --------------------------------------------------
        # 2. Проверяем crash
        # --------------------------------------------------

        avi_settle_if_expired(
            cur,
            round_id,
            user_id,
            bet_id,
            bet,
            started_flying_at,
            crash_point,
        )

        # Проверяем ставку после settle.
        cur.execute("""
            SELECT
                status,
                bet
            FROM aviator_bets
            WHERE bet_id = %s
        """, (bet_id,))

        bet_row = cur.fetchone()

        if not bet_row or bet_row[0] != "pending":
            cur.close()
            raise HTTPException(
                status_code=400,
                detail="Самолётик уже разбился"
            )

        # --------------------------------------------------
        # 3. Считаем текущий множитель
        # --------------------------------------------------

        current_mult = avi_current_multiplier(
            started_flying_at,
            crash_point
        )

        # Если множитель уже дошёл до crash point — проигрыш.
        if current_mult >= crash_point:
            avi_settle_if_expired(
                cur,
                round_id,
                user_id,
                bet_id,
                bet,
                started_flying_at,
                crash_point,
            )

            cur.close()

            raise HTTPException(
                status_code=400,
                detail="Самолётик уже разбился"
            )

        payout = int(bet * current_mult)

        # --------------------------------------------------
        # 4. Атомарно фиксируем cashout
        # --------------------------------------------------

        cur.execute("""
            UPDATE aviator_bets
            SET
                status = 'cashed_out',
                cashout_multiplier = %s,
                payout = %s
            WHERE bet_id = %s
              AND status = 'pending'
        """, (
            current_mult,
            payout,
            bet_id
        ))

        if not cur.rowcount:
            # --------------------------------------------------
            # ИДЕМПОТЕНТНОСТЬ: сюда мы попадаем, если между "проверили
            # status='pending' выше" и этим UPDATE кто-то (например,
            # повторный запрос того же клиента после обрыва сети —
            # именно так раунд мог выглядеть "не остановленным", хотя
            # игрок реально нажал "Забрать") уже успел закрыть эту
            # ставку. Раньше здесь падала ошибка "Ставка уже
            # обработана", и клиент, получивший её на ПЕРВОЙ попытке
            # кэшаута (ответ потерялся по сети, а сам запрос на сервер
            # дошёл и применился), думал, что кэшаут не прошёл — хотя
            # на сервере ставка уже была закрыта. Раунд при этом
            # оставался живым в глазах игрока, и следующий заход в игру
            # "воскрешал" его с уже большим множителем.
            #
            # Теперь вместо ошибки просто отдаём тот же результат,
            # которым ставка была закрыта на самом деле — повторный
            # (или запоздавший) вызов кэшаута безопасен и всегда
            # возвращает актуальный, а не потерянный ответ.
            cur.execute("""
                SELECT status, cashout_multiplier, payout
                FROM aviator_bets
                WHERE bet_id = %s
            """, (bet_id,))
            existing = cur.fetchone()

            if existing and existing[0] == "cashed_out":
                _, existing_mult, existing_payout = existing
                cur.execute(
                    "SELECT balance FROM user_chances WHERE user_id = %s",
                    (user_id,)
                )
                bal_row = cur.fetchone()
                cur.close()
                return {
                    "ok": True,
                    "round_id": str(round_id),
                    "bet_id": str(bet_id),
                    "multiplier": existing_mult,
                    "payout": existing_payout,
                    "new_balance": bal_row[0] if bal_row else None,
                    "replayed": True,
                }

            cur.close()
            raise HTTPException(
                status_code=400,
                detail="Ставка уже обработана"
            )

        # Помечаем и сам раунд как завершённый кэшаутом — раньше
        # aviator_rounds так и оставался status='flying' в БД навсегда
        # (пусть и не переиспользовался благодаря фильтру по
        # aviator_bets.status='pending', но это мусор в данных и риск
        # при любых будущих запросах/миграциях, которые опираются на
        # aviator_rounds.status напрямую).
        cur.execute("""
            UPDATE aviator_rounds
            SET status = 'cashed_out'
            WHERE round_id = %s
              AND status = 'flying'
        """, (round_id,))

        # --------------------------------------------------
        # 5. Возвращаем выигрыш
        # --------------------------------------------------

        cur.execute("""
            SELECT balance
            FROM user_chances
            WHERE user_id = %s
        """, (user_id,))

        balance_row = cur.fetchone()
        balance = balance_row[0] if balance_row else 0

        new_balance = balance + payout

        cur.execute("""
            UPDATE user_chances
            SET balance = %s
            WHERE user_id = %s
        """, (new_balance, user_id))

        # --------------------------------------------------
        # 6. Записываем общую историю
        # --------------------------------------------------

        cur.execute("""
            INSERT INTO game_rounds
                (
                    game_round_id,
                    user_id,
                    game_type,
                    bet,
                    result_label,
                    payout,
                    balance_change,
                    balance_after
                )
            VALUES
                (%s, %s, 'aviator', %s, %s, %s, %s, %s)
        """, (
            str(uuid.uuid4()),
            user_id,
            bet,
            f"{current_mult}x",
            payout,
            payout - bet,
            new_balance
        ))

        cur.close()

    return {
        "ok": True,
        "round_id": str(round_id),
        "bet_id": str(bet_id),
        "multiplier": current_mult,
        "payout": payout,
        "new_balance": new_balance
    }


# ---------- блэкджек (1 игрок против дилера) ----------

BJ_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
BJ_SUITS = ["♠", "♥", "♦", "♣"]


def bj_new_deck() -> list:
    deck = [{"r": r, "s": s} for r in BJ_RANKS for s in BJ_SUITS]
    random.shuffle(deck)
    return deck


def bj_hand_value(cards: list) -> tuple[int, bool]:
    """Возвращает (сумма, мягкая ли рука — есть туз, считающийся за 11)."""
    total = 0
    aces = 0
    for c in cards:
        r = c["r"]
        if r == "A":
            total += 11
            aces += 1
        elif r in ("J", "Q", "K"):
            total += 10
        else:
            total += int(r)
    soft = aces > 0
    while total > 21 and aces > 0:
        total -= 10
        aces -= 1
        soft = aces > 0
    return total, soft


def bj_is_blackjack(cards: list) -> bool:
    return len(cards) == 2 and bj_hand_value(cards)[0] == 21


def bj_load_hand(cur, user_id: int, hand_id: str) -> dict:
    cur.execute("""
        SELECT hand_id, user_id, bet, status, deck, player_cards, dealer_cards
        FROM blackjack_hands WHERE hand_id = %s
    """, (hand_id,))
    row = cur.fetchone()
    if not row or row[1] != user_id:
        raise HTTPException(status_code=404, detail="Раздача не найдена")
    return {
        "hand_id": row[0], "user_id": row[1], "bet": row[2], "status": row[3],
        "deck": row[4], "player_cards": row[5], "dealer_cards": row[6],
    }


def bj_dealer_play(deck: list, dealer_cards: list) -> None:
    # Дилер берёт карты, пока сумма меньше 17 (стоит на "мягких" 17).
    while bj_hand_value(dealer_cards)[0] < 17:
        dealer_cards.append(deck.pop())


def bj_settle(cur, hand: dict, user_id: int, final_dealer_cards: list, status: str, result_label: str, payout: int) -> dict:
    cur.execute("""
        UPDATE blackjack_hands SET status = %s, dealer_cards = %s WHERE hand_id = %s
    """, (status, json.dumps(final_dealer_cards), hand["hand_id"]))

    cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    balance = row[0] if row else 0
    new_balance = balance + payout
    cur.execute("UPDATE user_chances SET balance = %s WHERE user_id = %s", (new_balance, user_id))

    net = payout - hand["bet"]
    cur.execute("""
        INSERT INTO game_rounds (game_round_id, user_id, game_type, bet, result_label, payout, balance_change, balance_after)
        VALUES (%s, %s, 'blackjack', %s, %s, %s, %s, %s)
    """, (str(uuid.uuid4()), user_id, hand["bet"], result_label, payout, net, new_balance))

    return {"new_balance": new_balance, "payout": payout, "result_label": result_label}


@app.get("/api/blackjack/state")
async def blackjack_state(token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        cur = conn.cursor()
        cur.execute("""
            SELECT hand_id, bet, player_cards, dealer_cards
            FROM blackjack_hands WHERE user_id = %s AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
        """, (user["user_id"],))
        row = cur.fetchone()
        cur.close()
    if not row:
        return {"has_hand": False}
    player_total, _ = bj_hand_value(row[2])
    return {
        "has_hand": True, "hand_id": str(row[0]), "bet": row[1],
        "player_cards": row[2], "player_total": player_total,
        "dealer_up_card": row[3][0],
    }


@app.post("/api/blackjack/start")
async def blackjack_start(body: BlackjackBetBody, token: str = Depends(bearer_token)):
    bet = body.bet
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]
        cur = conn.cursor()

        cur.execute("SELECT 1 FROM blackjack_hands WHERE user_id = %s AND status = 'active'", (user_id,))
        if cur.fetchone():
            cur.close()
            raise HTTPException(status_code=400, detail="У вас уже есть незавершённая раздача")

        cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        balance = row[0] if row else 0
        if balance < bet:
            cur.close()
            raise HTTPException(status_code=400, detail="Недостаточно GP на балансе")

        deck = bj_new_deck()
        player_cards = [deck.pop(), deck.pop()]
        dealer_cards = [deck.pop(), deck.pop()]
        hand_id = str(uuid.uuid4())

        new_balance = balance - bet
        cur.execute("UPDATE user_chances SET balance = %s WHERE user_id = %s", (new_balance, user_id))

        import json as _json
        cur.execute("""
            INSERT INTO blackjack_hands (hand_id, user_id, bet, status, deck, player_cards, dealer_cards)
            VALUES (%s, %s, %s, 'active', %s, %s, %s)
        """, (hand_id, user_id, bet, json.dumps(deck), json.dumps(player_cards), json.dumps(dealer_cards)))

        hand = {"hand_id": hand_id, "bet": bet}
        player_total, _ = bj_hand_value(player_cards)
        dealer_total, _ = bj_hand_value(dealer_cards)

        # Натуральный блэкджек у игрока — раздача сразу завершается.
        if bj_is_blackjack(player_cards):
            if bj_is_blackjack(dealer_cards):
                result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Пуш (блэкджек/блэкджек)", bet)
            else:
                payout = bet + math.floor(bet * 1.5 + 0.5)
                result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Блэкджек! 3:2", payout)
            cur.close()
            return {
                "ok": True, "hand_id": hand_id, "status": "finished",
                "player_cards": player_cards, "dealer_cards": dealer_cards,
                "player_total": player_total, "dealer_total": bj_hand_value(dealer_cards)[0],
                **result,
            }

        cur.close()
        return {
            "ok": True, "hand_id": hand_id, "status": "active", "bet": bet,
            "player_cards": player_cards, "player_total": player_total,
            "dealer_up_card": dealer_cards[0], "new_balance": new_balance,
        }


@app.post("/api/blackjack/hit")
async def blackjack_hit(body: BlackjackHandBody, token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]
        cur = conn.cursor()
        hand = bj_load_hand(cur, user_id, body.hand_id)
        if hand["status"] != "active":
            cur.close()
            raise HTTPException(status_code=400, detail="Раздача уже завершена")

        deck, player_cards = hand["deck"], hand["player_cards"]
        player_cards.append(deck.pop())
        player_total, _ = bj_hand_value(player_cards)

        import json as _json
        if player_total > 21:
            result = bj_settle(cur, hand, user_id, hand["dealer_cards"], "finished", "Перебор — дилер выиграл", 0)
            cur.close()
            return {
                "ok": True, "status": "finished", "player_cards": player_cards,
                "dealer_cards": hand["dealer_cards"], "player_total": player_total,
                "dealer_total": bj_hand_value(hand["dealer_cards"])[0], **result,
            }

        cur.execute("""
            UPDATE blackjack_hands SET deck = %s, player_cards = %s WHERE hand_id = %s
        """, (json.dumps(deck), json.dumps(player_cards), hand["hand_id"]))
        cur.close()
        return {
            "ok": True, "status": "active", "player_cards": player_cards,
            "player_total": player_total, "dealer_up_card": hand["dealer_cards"][0],
        }


@app.post("/api/blackjack/stand")
async def blackjack_stand(body: BlackjackHandBody, token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]
        cur = conn.cursor()
        hand = bj_load_hand(cur, user_id, body.hand_id)
        if hand["status"] != "active":
            cur.close()
            raise HTTPException(status_code=400, detail="Раздача уже завершена")

        deck, dealer_cards = hand["deck"], hand["dealer_cards"]
        bj_dealer_play(deck, dealer_cards)
        player_total, _ = bj_hand_value(hand["player_cards"])
        dealer_total, _ = bj_hand_value(dealer_cards)

        if dealer_total > 21 or player_total > dealer_total:
            result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Вы выиграли", hand["bet"] * 2)
        elif player_total == dealer_total:
            result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Пуш — ставка возвращена", hand["bet"])
        else:
            result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Дилер выиграл", 0)

        cur.close()
        return {
            "ok": True, "status": "finished", "player_cards": hand["player_cards"],
            "dealer_cards": dealer_cards, "player_total": player_total,
            "dealer_total": dealer_total, **result,
        }


@app.post("/api/blackjack/double")
async def blackjack_double(body: BlackjackHandBody, token: str = Depends(bearer_token)):
    with db() as conn:
        user = require_session(conn, token)
        user_id = user["user_id"]
        cur = conn.cursor()
        hand = bj_load_hand(cur, user_id, body.hand_id)
        if hand["status"] != "active":
            cur.close()
            raise HTTPException(status_code=400, detail="Раздача уже завершена")
        if len(hand["player_cards"]) != 2:
            cur.close()
            raise HTTPException(status_code=400, detail="Удвоить можно только сразу после раздачи")

        cur.execute("SELECT balance FROM user_chances WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        balance = row[0] if row else 0
        if balance < hand["bet"]:
            cur.close()
            raise HTTPException(status_code=400, detail="Недостаточно GP для удвоения")

        new_balance = balance - hand["bet"]
        cur.execute("UPDATE user_chances SET balance = %s WHERE user_id = %s", (new_balance, user_id))

        hand["bet"] *= 2
        deck, player_cards = hand["deck"], hand["player_cards"]
        player_cards.append(deck.pop())
        player_total, _ = bj_hand_value(player_cards)

        cur.execute("UPDATE blackjack_hands SET bet = %s WHERE hand_id = %s", (hand["bet"], hand["hand_id"]))

        if player_total > 21:
            result = bj_settle(cur, hand, user_id, hand["dealer_cards"], "finished", "Перебор — дилер выиграл", 0)
            cur.close()
            return {
                "ok": True, "status": "finished", "player_cards": player_cards,
                "dealer_cards": hand["dealer_cards"], "player_total": player_total,
                "dealer_total": bj_hand_value(hand["dealer_cards"])[0], **result,
            }

        dealer_cards = hand["dealer_cards"]
        bj_dealer_play(deck, dealer_cards)
        dealer_total, _ = bj_hand_value(dealer_cards)

        if dealer_total > 21 or player_total > dealer_total:
            result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Вы выиграли (х2)", hand["bet"] * 2)
        elif player_total == dealer_total:
            result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Пуш — ставка возвращена", hand["bet"])
        else:
            result = bj_settle(cur, hand, user_id, dealer_cards, "finished", "Дилер выиграл", 0)

        cur.close()
        return {
            "ok": True, "status": "finished", "player_cards": player_cards,
            "dealer_cards": dealer_cards, "player_total": player_total,
            "dealer_total": dealer_total, **result,
        }
