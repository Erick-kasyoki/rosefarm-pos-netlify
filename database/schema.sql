-- =====================================================
--  POS schema for PostgreSQL
--  1) Create the database:   CREATE DATABASE pos_db;
--  2) Connect to it and run this whole file (pgAdmin Query Tool or psql -d pos_db -f schema.sql)
--  Normally you do NOT run this by hand: setup.php (local) or `php bin/install.php` (server) runs it,
--  then creates the first admin login. This file creates no users and no default passwords.
-- =====================================================

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    full_name     VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'cashier' CHECK (role IN ('admin','manager','cashier')),
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS suppliers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(120) NOT NULL,
    phone      VARCHAR(30),
    email      VARCHAR(120),
    address    VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id            SERIAL PRIMARY KEY,
    sku           VARCHAR(50)  NOT NULL UNIQUE,
    barcode       VARCHAR(60)  UNIQUE,
    name          VARCHAR(150) NOT NULL,
    category_id   INT REFERENCES categories(id) ON DELETE SET NULL,
    supplier_id   INT REFERENCES suppliers(id) ON DELETE SET NULL,
    price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    cost          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
    unit          VARCHAR(20)  NOT NULL DEFAULT 'pc',      -- pc, kg, L, tray, pack ... (kg and L allow decimals)
    stock         NUMERIC(12,3) NOT NULL DEFAULT 0,
    reorder_level NUMERIC(12,3) NOT NULL DEFAULT 5,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products (LOWER(name));

CREATE TABLE IF NOT EXISTS stock_receipts (
    id            SERIAL PRIMARY KEY,
    product_id    INT REFERENCES products(id) ON DELETE SET NULL,
    product_name  VARCHAR(150) NOT NULL,
    qty           NUMERIC(12,3) NOT NULL CHECK (qty > 0),
    cost          NUMERIC(12,2) NOT NULL DEFAULT 0,
    supplier_id   INT REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name VARCHAR(120),
    note          VARCHAR(255),
    user_id       INT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_receipts_created ON stock_receipts (created_at);

CREATE TABLE IF NOT EXISTS customers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(120) NOT NULL,           -- full name, kept in sync with first_name + last_name
    first_name VARCHAR(60),
    last_name  VARCHAR(60),
    phone      VARCHAR(30),
    email      VARCHAR(120),
    address    VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1;

CREATE TABLE IF NOT EXISTS sales (
    id             SERIAL PRIMARY KEY,
    receipt_no     VARCHAR(20) NOT NULL UNIQUE,
    user_id        INT NOT NULL REFERENCES users(id),
    customer_id    INT REFERENCES customers(id) ON DELETE SET NULL,
    subtotal       NUMERIC(12,2) NOT NULL,
    discount       NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax            NUMERIC(12,2) NOT NULL DEFAULT 0,
    total          NUMERIC(12,2) NOT NULL,
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash','card','mpesa')),
    amount_paid    NUMERIC(12,2) NOT NULL,
    change_due     NUMERIC(12,2) NOT NULL DEFAULT 0,
    status         VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
    created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales (created_at);

CREATE TABLE IF NOT EXISTS sale_items (
    id         SERIAL PRIMARY KEY,
    sale_id    INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INT REFERENCES products(id) ON DELETE SET NULL,
    name       VARCHAR(150) NOT NULL,
    qty        NUMERIC(12,3) NOT NULL CHECK (qty > 0),
    unit       VARCHAR(20) NOT NULL DEFAULT 'pc',
    price      NUMERIC(12,2) NOT NULL,
    cost       NUMERIC(12,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);

CREATE TABLE IF NOT EXISTS settings (
    name  VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS expenses (
    id             SERIAL PRIMARY KEY,
    expense_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
    category       VARCHAR(60)   NOT NULL,
    description    VARCHAR(255)  NOT NULL DEFAULT '',
    amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(20)   NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','bank','mpesa')),
    user_id        INT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMP     NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date);

-- Failed logins and sign-ups, used to slow down password guessing and sign-up spam.
CREATE TABLE IF NOT EXISTS login_attempts (
    id         SERIAL PRIMARY KEY,
    ip         VARCHAR(45) NOT NULL,
    username   VARCHAR(50) NOT NULL DEFAULT '',
    kind       VARCHAR(10) NOT NULL DEFAULT 'login',
    created_at TIMESTAMP   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (kind, ip, created_at);

-- ---------- Starting data ----------
-- No users are created here: the installer creates the first admin with a password you choose (or a random one).
-- No demo products either: as admin, open Products and press "Load shop products" if you want the starter catalogue.
INSERT INTO settings (name, value) VALUES
 ('store_name', 'RoseFarm'),
 ('address', 'Nairobi, Kenya'),
 ('phone', '+254 700 000000'),
 ('currency', 'KES'),
 ('tax_rate', '0'),
 ('receipt_footer', 'Growing faith, feeding families, living purpose.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO categories (name) VALUES
 ('Milk & Mala'), ('Eggs'), ('Chicken'), ('Cereals'), ('Flours'), ('Cooking Oil')
ON CONFLICT (name) DO NOTHING;
