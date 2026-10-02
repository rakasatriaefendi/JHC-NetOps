# Agent and Runner Setup

This is the active local-only setup. Older phase runbooks under P12/P13 document
historical migrations and are not runtime setup instructions.

## 1. Backend

Create `backend/.env` from the example. Configure the exact dedicated
PostgreSQL database, loopback host/port, distinct runner/frontend tokens, and
`PERSISTENCE_AUTHORITY=local_postgres`. Never target `16/main:5432`.

```powershell
npm.cmd --prefix backend ci
npm.cmd --prefix backend run dev
```

Backend startup validates configuration but does not apply migrations.

## 2. Frontend

Create `frontend/.env.local` from the example. Backend URL/token stay
server-only and must not use `NEXT_PUBLIC_`.

```powershell
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run dev
```

## 3. Python agent

```bash
cd agent
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

Install `iperf3`, `mtr`, and other platform tools only through the reviewed
host provisioning procedure. Do not copy a virtualenv between Windows/WSL and
native Ubuntu.

## 4. Local Runner

Create `runner/.env` and the ignored local config. The runner requires
`LOCAL_BACKEND_URL`, `LOCAL_BACKEND_TOKEN`, and
`PERSISTENCE_AUTHORITY=local_postgres`. Configure only authorized target IDs,
hosts, ports, and local SNMP credential-profile references.

```powershell
npm.cmd --prefix runner test
powershell -ExecutionPolicy Bypass -File runner\task.ps1 status
```

Native Ubuntu uses the shared config and `deploy/run-runner.sh`.

## 5. Verification

```powershell
npm.cmd --prefix backend test
npm.cmd --prefix backend run typecheck
npm.cmd --prefix backend run lint
npm.cmd --prefix backend run build
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run typecheck
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
npm.cmd --prefix runner test
```

```bash
cd agent
source .venv/bin/activate
python -m pytest
```

Do not run live Discovery, diagnostics, capture, SNMP, or scans merely as a setup
check. Use only an explicitly authorized acceptance plan.
