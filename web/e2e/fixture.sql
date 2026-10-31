CREATE TABLE customers (
	id serial PRIMARY KEY,
	email text NOT NULL
);

CREATE TABLE orders (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	customer_id integer NOT NULL REFERENCES customers,
	note text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
	order_id bigint REFERENCES orders,
	position integer,
	quantity numeric(10, 2) NOT NULL,
	PRIMARY KEY (order_id, position)
);

CREATE TABLE shipments (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	order_id bigint,
	position integer,
	FOREIGN KEY (order_id, position) REFERENCES order_items
);

CREATE TABLE events (
	id integer,
	at date,
	PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE TABLE readings (
	id integer PRIMARY KEY,
	payload text NOT NULL
);

CREATE SCHEMA audit;

CREATE TABLE audit."Event Log" (
	id integer PRIMARY KEY,
	"Payload" jsonb
);

INSERT INTO customers (email) VALUES ('ada@example.com'), ('alan@example.com'), ('grace@example.com');
INSERT INTO orders (customer_id) VALUES (1), (1), (2), (3);
INSERT INTO order_items VALUES (1, 1, 1), (1, 2, 2.5), (2, 1, 1), (3, 1, 4), (4, 1, 1);
INSERT INTO shipments (order_id, position) VALUES (1, 1), (3, 1);
INSERT INTO events VALUES (1, '2026-03-01'), (2, '2026-10-30');
INSERT INTO readings SELECT id, repeat('x', 100) FROM generate_series(1, 200000) id;
INSERT INTO audit."Event Log" VALUES (1, '{"type": "signup"}');

CREATE VIEW recent_orders AS SELECT id, customer_id FROM orders WHERE id > 2;

CREATE MATERIALIZED VIEW customer_totals AS
	SELECT customer_id, count(*) AS orders FROM orders GROUP BY customer_id;
