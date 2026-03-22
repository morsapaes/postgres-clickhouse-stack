[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# Postgres + ClickHouse = The Open Source Unified Data Stack

This repository provides a ready-to-use open source data stack that combines [Postgres](https://www.Postgres.org/) and [ClickHouse](https://clickhouse.com/) to handle both transactional and analytical workloads.

Postgres is the primary database and source of truth for application data. [PeerDB](https://www.peerdb.io/) streams changes to ClickHouse using CDC, keeping it in sync in near real time. The [`pg_clickhouse`](https://clickhouse.com/blog/introducing-pg_clickhouse) extension allows Postgres to transparently offload analytical queries to ClickHouse without any application code changes.

## What's included

| Component | Role |
|-----------|------|
| **Postgres** | OLTP database, source of truth |
| **ClickHouse** | OLAP database, optimized for aggregations |
| **PeerDB** | CDC-based replication from Postgres to ClickHouse |
| **pg_clickhouse** | FDW extension for transparent query offloading |
| **Expense app** | Sample Next.js app to demonstrate the end-to-end stack |

## Architecture

![Architecture](./images/architecture-main.png)

The sample app uses a single table:

```sql
CREATE TABLE expenses (
  id          SERIAL PRIMARY KEY,
  description TEXT           NOT NULL,
  amount      DECIMAL(10,2)  NOT NULL,
  category    VARCHAR(100),
  date        DATE           NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP
);
```

PeerDB replicates this table to ClickHouse (`expense` database). The `pg_clickhouse` FDW then exposes the ClickHouse copy back into Postgres as a foreign table under the `expense_ch` schema. The app can then route analytical queries to ClickHouse simply by changing `search_path`, with no SQL changes required.

---

## Workshop walkthrough

### Prerequisites

- Docker
- Bash

> **OrbStack users:** when configuring PeerDB peers below, use service names (`postgres`, `clickhouse`) as the host instead of `host.docker.internal`. OrbStack does not route inter-container traffic through the host, so `host.docker.internal` will fail with a connection refused error.

---

### Step 1: Connect to Postgres

```bash
git clone git@github.com:ClickHouse/postgres-clickhouse-stack.git
cd postgres-clickhouse-stack
./run.sh start
```

This starts all services:

| Service | URL |
|---------|-----|
| Expense app | http://localhost:18080 |
| PeerDB UI | http://localhost:13000 |
| ClickHouse UI | http://localhost:18123/play |

Open two terminal windows — one for each database. You'll keep them both running throughout the workshop.

---

Open a Postgres session:

```bash
./run.sh psql
```

Take a look at what's already set up:

```sql
-- What tables exist?
\dt

-- What does the expenses table look like?
\d expenses
```

Insert a few rows directly via SQL:

```sql
INSERT INTO expenses (description, amount, category) VALUES
  ('Lunch',  18.50, 'Food'),
  ('Taxi',   12.00, 'Transport'),
  ('Book',   24.99, 'Education');
```

Then open the expense app at http://localhost:18080 and add one more record using the UI. Come back to the psql session and confirm all rows are there:

```sql
SELECT * FROM expenses;
```

This establishes the "before" state — data exists in Postgres, and nowhere else yet.

---

### Step 2: Connect to ClickHouse

Open a ClickHouse session in the second terminal:

```bash
./run.sh clickhouse
```

```sql
-- What databases exist?
SHOW DATABASES;
```

ClickHouse has no `expense` database yet, so it knows nothing about the data in Postgres. The next steps will change that.

---

Before setting up replication, you need to create the destination database in ClickHouse manually. PeerDB will replicate tables into it, but it won't create the database itself.

The name you choose here needs to match the database you specify when configuring the ClickHouse peer in PeerDB (Step 5) and in the FDW setup (Step 8). In this demo it's `expense`.

```sql
-- In the ClickHouse session
CREATE DATABASE IF NOT EXISTS expense;

SHOW DATABASES;
-- 'expense' now appears

SHOW TABLES FROM expense;
-- empty for now, PeerDB will populate this
```

---

### Step 3: Set up Change Data Capture (CDC)

Open the [PeerDB UI](http://localhost:13000) and navigate to **Peers → Create peer**.

PeerDB needs to know how to connect to both databases. Think of a peer as a saved connection: source on one side, destination on the other.

#### Create a Postgres peer

| Field | Value |
|-------|-------|
| Name | `postgres` |
| Host | `postgres` (OrbStack) or `host.docker.internal` (Docker Desktop) |
| Port | `5432` |
| User | `admin` |
| Password | `password` |
| Database | `postgres` |

Click **Validate**, then **Create peer**.

#### Create a ClickHouse peer

| Field | Value |
|-------|-------|
| Name | `clickhouse` |
| Host | `clickhouse` (OrbStack) or `host.docker.internal` (Docker Desktop) |
| Port | `9000` |
| User | `default` |
| Password | `clickhouse` |
| Database | `expense` |

Click **Validate**, then **Create peer**.

---

#### Create a CDC mirror from Postgres to ClickHouse

In the PeerDB UI, navigate to **Mirrors → Create mirror** and select **CDC**.

| Field | Value |
|-------|-------|
| Name | `expense_replication` |
| Source peer | `postgres` |
| Destination peer | `clickhouse` |

Under **Tables**, select `public.expenses` and confirm the destination table name is `expenses`.

Click **Create mirror**.

PeerDB will first take an initial snapshot of the existing rows, then switch to streaming new changes in real time by tailing the Postgres WAL (write-ahead log). You can watch the snapshot progress in the mirror status page.

---

### Step 4: What are we looking at?

Once the initial snapshot completes, verify the rows have landed in ClickHouse:

```sql
-- In the ClickHouse session
SHOW TABLES FROM expense;
-- 'expenses' now appears

DESCRIBE expense.expenses;
```

Run an aggregation to confirm the data is there and get a feel for what ClickHouse is good at:

```sql
SELECT
    category,
    count(*)    AS total,
    sum(amount) AS total_spent
FROM expense.expenses
GROUP BY category
ORDER BY total_spent DESC;
```

Now go to the Postgres session and insert a new row:

```sql
-- In the Postgres session
INSERT INTO expenses (description, amount, category)
VALUES ('Coffee', 3.50, 'Food');
```

Switch back to the ClickHouse session and re-run the aggregation. The new row should already be reflected:

```sql
-- In the ClickHouse session
SELECT
    category,
    count(*)    AS total,
    sum(amount) AS total_spent
FROM expense.expenses
GROUP BY category
ORDER BY total_spent DESC;
```

No batch job, no polling. PeerDB decoded the change from the Postgres WAL and streamed it directly to ClickHouse. Try an UPDATE too:

```sql
-- In the Postgres session
UPDATE expenses SET amount = 4.50 WHERE description = 'Coffee';
```

```sql
-- In the ClickHouse session
SELECT category, count(*), sum(amount) AS total_spent
FROM expense.expenses
GROUP BY category
ORDER BY total_spent DESC;
```

---

### Step 5: Offload app analytics to ClickHouse

Data is replicating. Now configure the `pg_clickhouse` foreign data wrapper (FDW) so Postgres can push analytical queries directly to ClickHouse transparently, without the application knowing.

Run this in the Postgres session:

```sql
-- Register ClickHouse as a foreign server
-- 'expense' must match the ClickHouse database created in Step 4
CREATE SERVER clickhouse_svr FOREIGN DATA WRAPPER clickhouse_fdw
  OPTIONS (dbname 'expense', host 'clickhouse');

-- Map the current Postgres user to the ClickHouse default user
CREATE USER MAPPING FOR CURRENT_USER SERVER clickhouse_svr
  OPTIONS (user 'default', password 'clickhouse');

-- Create a schema to hold the foreign table definitions
CREATE SCHEMA IF NOT EXISTS expense_ch;

-- Import all tables from ClickHouse's 'expense' database into that schema
IMPORT FOREIGN SCHEMA expense FROM SERVER clickhouse_svr INTO expense_ch;
```

Verify everything is in place:

```sql
-- The pg_clickhouse extension should now be visible
\dx

-- The new schema should appear alongside public
\dn

-- Compare the real table and the foreign table (same columns, different backends)
\d expenses
\d expense_ch.expenses
```

The key difference: `expenses` is a real Postgres table. `expense_ch.expenses` is a foreign table (i.e. a pointer to ClickHouse). Any query against it gets pushed down and executed in ClickHouse.

---

### Step 6: Run the same query against both tables

Run the same aggregation against both tables and compare:

```sql
-- Against Postgres (local execution)
SELECT
    category,
    count(*)    AS total,
    sum(amount) AS total_spent
FROM expenses
GROUP BY category
ORDER BY total_spent DESC;

-- Against ClickHouse via the FDW (push-down execution)
SET search_path = expense_ch, public;

SELECT
    category,
    count(*)    AS total,
    sum(amount) AS total_spent
FROM public_expenses
GROUP BY category
ORDER BY total_spent DESC;
```

The results are identical. But look at the query plan for the second query:

```sql
EXPLAIN SELECT
    category,
    count(*)    AS total,
    sum(amount) AS total_spent
FROM public_expenses
GROUP BY category
ORDER BY total_spent DESC;
```

The plan shows `Foreign Scan ... Aggregate on (expenses)`, which means that Postgres is not doing any of the aggregation work itself. The entire query was pushed down to ClickHouse and Postgres just returned the result.

Reset the search path when done:

```sql
SET search_path = public;
```

---

### Step 7: Compare query performance at scale

Seed Postgres with enough data to see a meaningful difference:

```bash
./run.sh seed              # 10 million rows (default)
./run.sh seed 100000000    # 100 million rows (recommended)
```

Wait for PeerDB to finish replicating the seeded rows (monitor progress in the PeerDB UI), then time the same aggregation against both backends:

```sql
\timing on

-- Postgres
SELECT
    category,
    count(*)    AS total,
    sum(amount) AS total_spent
FROM expenses
GROUP BY category
ORDER BY total_spent DESC;

-- ClickHouse via FDW
SET search_path = expense_ch, public;

SELECT
    category,
    count(*)    AS total,
    sum(amount) AS total_spent
FROM public_expenses
GROUP BY category
ORDER BY total_spent DESC;
```

You can also use the toggle on the [analytics dashboard](http://localhost:18080/analytics) to switch backends visually, or from the terminal:

```bash
./run.sh use-postgres     # query public.expenses directly
./run.sh use-clickhouse   # query via expense_ch (FDW → ClickHouse)
```

The app switches by changing `search_path` on the connection (no SQL changes):

```typescript
const pool = new Pool({
  ...
  options: process.env.DB_SCHEMA
    ? `-c search_path=${process.env.DB_SCHEMA},public`
    : undefined,
});
```

When `DB_SCHEMA=expense_ch`, Postgres resolves `expenses` to the foreign table and the query executes in ClickHouse.

---

### Fell behind? Catch up with one command

To skip Steps 4–8 and jump straight to the performance comparison:

```bash
./run.sh migrate
```

This automates everything: creates the ClickHouse database, configures both PeerDB peers, starts the CDC mirror, and sets up the FDW.

---

### Stop the stack

```bash
./run.sh stop
```

---

## Using this stack with your own application

The sample app demonstrates one specific schema, but the pattern generalises to any Postgres application:

1. Identify the tables used for analytical queries.
2. Create a matching database in ClickHouse.
3. Configure PeerDB peers and a CDC mirror via the [PeerDB UI](http://localhost:13000) or API.
4. Run the FDW setup substituting your database name.
5. Set `search_path` to your foreign schema on the analytical connection.

See the [PeerDB CDC documentation](https://docs.peerdb.io/mirror/cdc-pg-clickhouse) and the [pg_clickhouse tutorial](https://github.com/ClickHouse/pg_clickhouse/blob/main/doc/tutorial.md) for full details.