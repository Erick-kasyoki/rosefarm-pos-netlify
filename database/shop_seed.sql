-- Starter catalogue for the shop (safe to run again: existing items are never changed).
INSERT INTO categories (name) VALUES
 ('Milk & Mala'), ('Eggs'), ('Chicken'), ('Cereals'), ('Flours'), ('Cooking Oil')
ON CONFLICT (name) DO NOTHING;

-- Starter catalogue. Prices are in KES and are only examples: change them under Products.
-- Loose items are sold by kg or litre (decimals allowed); packed items by pc / tray / pack.
INSERT INTO products (sku, barcode, name, category_id, unit, price, cost, stock, reorder_level)
SELECT v.sku, NULL, v.name, (SELECT id FROM categories WHERE name = v.cat), v.unit, v.price, v.cost, v.stock, v.rl
FROM (VALUES
 -- Milk & Mala
 ('MLK001','Fresh Milk (loose)',      'Milk & Mala','L',    80,   62,  100, 20),
 ('MLK002','Fresh Milk 500ml packet', 'Milk & Mala','pc',   65,   54,   60, 12),
 ('MLK003','Mala (loose)',            'Milk & Mala','L',   140,  110,   60, 15),
 ('MLK004','Mala 500ml packet',       'Milk & Mala','pc',   70,   56,   48, 12),
 -- Eggs
 ('EGG001','Eggs (single)',           'Eggs',       'pc',   18,   14,  120, 30),
 ('EGG002','Eggs tray (30)',          'Eggs',       'tray',480,  420,   20,  4),
 -- Chicken
 ('CHK001','Broiler chicken (whole)', 'Chicken',    'kg',  550,  450,   40, 10),
 ('CHK002','Kienyeji chicken (bird)', 'Chicken',    'pc', 1100,  900,   12,  3),
 ('CHK003','Chicken breast',          'Chicken',    'kg',  750,  620,   15,  5),
 ('CHK004','Chicken wings',           'Chicken',    'kg',  600,  480,   15,  5),
 -- Cereals
 ('CER001','Rice (Pishori)',          'Cereals',    'kg',  220,  180,   50, 10),
 ('CER002','Maize grain',             'Cereals',    'kg',   80,   60,  100, 20),
 ('CER003','Beans (Rosecoco)',        'Cereals',    'kg',  200,  160,   60, 10),
 ('CER004','Green grams (ndengu)',    'Cereals',    'kg',  220,  180,   40, 10),
 ('CER005','Millet',                  'Cereals',    'kg',  150,  110,   30, 10),
 ('CER006','Corn Flakes 500g',        'Cereals',    'pc',  430,  360,   18,  5),
 ('CER007','Oats 500g',               'Cereals',    'pc',  250,  200,   18,  5),
 -- Flours
 ('FLR001','Maize flour 2kg',         'Flours',     'pc',  190,  165,   60, 12),
 ('FLR002','Maize flour (loose)',     'Flours',     'kg',   90,   75,   80, 20),
 ('FLR003','Wheat flour 2kg',         'Flours',     'pc',  220,  190,   40, 10),
 ('FLR004','Millet flour (loose)',    'Flours',     'kg',  160,  120,   25, 8),
 ('FLR005','Sorghum flour (loose)',   'Flours',     'kg',  140,  105,   25, 8),
 -- Cooking Oil
 ('OIL001','Cooking oil (loose)',     'Cooking Oil','L',   330,  280,   60, 15),
 ('OIL002','Cooking oil 500ml',       'Cooking Oil','pc',  190,  165,   30,  8),
 ('OIL003','Cooking oil 1L',          'Cooking Oil','pc',  340,  295,   36, 10),
 ('OIL004','Cooking oil 5L',          'Cooking Oil','pc', 1650, 1480,   10,  3)
) AS v(sku, name, cat, unit, price, cost, stock, rl)
ON CONFLICT (sku) DO NOTHING;
