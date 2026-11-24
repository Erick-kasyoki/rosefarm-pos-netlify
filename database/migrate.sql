-- Upgrade for databases created with the older schema (whole-number quantities, no units).
-- setup.php runs this every time. It is safe to run again and never deletes data.
ALTER TABLE products   ADD COLUMN IF NOT EXISTS unit VARCHAR(20) NOT NULL DEFAULT 'pc';
ALTER TABLE products   ALTER COLUMN stock         TYPE NUMERIC(12,3);
ALTER TABLE products   ALTER COLUMN reorder_level TYPE NUMERIC(12,3);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit VARCHAR(20) NOT NULL DEFAULT 'pc';
ALTER TABLE sale_items ALTER COLUMN qty TYPE NUMERIC(12,3);

-- Manager role + expenses (added in the second release).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','manager','cashier'));
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

-- Suppliers and stock receiving (third release).
CREATE TABLE IF NOT EXISTS suppliers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(120) NOT NULL,
    phone      VARCHAR(30),
    email      VARCHAR(120),
    address    VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id INT REFERENCES suppliers(id) ON DELETE SET NULL;
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


-- Customers: first name, last name, address (fourth release). Existing names are split on the first space.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS first_name VARCHAR(60);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_name  VARCHAR(60);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address    VARCHAR(255);
UPDATE customers SET first_name = split_part(name, ' ', 1),
                     last_name  = NULLIF(trim(substr(name, length(split_part(name, ' ', 1)) + 1)), '')
 WHERE first_name IS NULL;

-- Login throttling and sign-up limits (deployment release).
CREATE TABLE IF NOT EXISTS login_attempts (
    id         SERIAL PRIMARY KEY,
    ip         VARCHAR(45) NOT NULL,
    username   VARCHAR(50) NOT NULL DEFAULT '',
    kind       VARCHAR(10) NOT NULL DEFAULT 'login',
    created_at TIMESTAMP   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (kind, ip, created_at);
