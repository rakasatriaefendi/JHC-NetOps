NETWORK INVENTORY DASHBOARD - MARIADB/MYSQL

1) Install OS packages:
   sudo apt update
   sudo apt install -y python3-full python3-venv python3-pip nmap mariadb-server

2) Create DB and application user:
   sudo mariadb

   CREATE DATABASE IF NOT EXISTS network_inventory
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

   CREATE USER IF NOT EXISTS 'network_inventory'@'localhost'
     IDENTIFIED BY 'GANTI_PASSWORD_KUAT';

   GRANT ALL PRIVILEGES ON network_inventory.* TO 'network_inventory'@'localhost';
   FLUSH PRIVILEGES;
   EXIT;

3) Create venv:
   cd /opt/network_inventory_dashboard
   python3 -m venv venv
   source venv/bin/activate
   python -m pip install --upgrade pip
   python -m pip install -r requirements.txt

4) Configure DB:
   export NETWORK_INVENTORY_DB_HOST=127.0.0.1
   export NETWORK_INVENTORY_DB_PORT=3306
   export NETWORK_INVENTORY_DB_NAME=network_inventory
   export NETWORK_INVENTORY_DB_USER=network_inventory
   export NETWORK_INVENTORY_DB_PASSWORD='GANTI_PASSWORD_KUAT'
   export NETWORK_INVENTORY_PORT=5002

5) Run:
   python network_inventory.py

Database/tables are created automatically if the DB user has CREATE DATABASE permission.
If the database/user was created manually as above, the application only creates missing tables.

The application no longer uses SQLite.
