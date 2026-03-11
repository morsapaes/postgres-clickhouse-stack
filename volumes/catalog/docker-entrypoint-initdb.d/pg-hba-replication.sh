#!/bin/sh
echo "host replication $POSTGRES_USER 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"
