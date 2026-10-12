# VISTA Development Guide

คู่มือลำดับขั้นตอนการรัน Service (**PostgreSQL**, **Redis** และ **Engine**) สำหรับการพัฒนา (Local Development) ในโปรเจกต์ SCORM Engine

---

## 1. โครงสร้าง Docker Compose

ระบบถูกแยกไฟล์ Compose ออกเป็นโมดูลเพื่อให้สะดวกต่อการพัฒนา:

| ไฟล์ Compose | Service | Port | รายละเอียด |
| :--- | :--- | :--- | :--- |
| [`docker/db.yml`](docker/db.yml) | `postgres` | `5432` | ฐานข้อมูล PostgreSQL 16 พร้อม Volume `./data/postgres` |
| [`docker/redis.yml`](docker/redis.yml) | `redis` | `6379` | In-Memory Cache Redis 7 |
| [`docker/docker-compose.yml`](docker/docker-compose.yml) | `engine` | `3000` | รวม `db.yml` + `redis.yml` + SCORM Engine API |

---

## 2. ลำดับการรันสำหรับ Local Development (แนะนำ)

เหมาะสำหรับการพัฒนาโค้ดแบบ Hot-reload (`npm run dev`) โดยรันเฉพาะ Database และ Redis ใน Docker

```mermaid
flowchart LR
    A["1. Start Postgres\n(docker/db.yml)"] --> B["2. Start Redis\n(docker/redis.yml)"]
    B --> C["3. Prisma Migrate\n(npm run db:migrate)"]
    C --> D["4. Start Engine\n(npm run dev)"]
```

### ขั้นตอนที่ 1: ตรวจสอบ Environment Variables
คัดลอกไฟล์คอนฟิก (หากยังไม่มี) และตรวจสอบค่าการเชื่อมต่อ:
```bash
cp .env.example .env
```
ตรวจสอบว่าใน `.env` ชี้ไปยัง `localhost`:
```env
DATABASE_URL=postgresql://scormflow:scormflow@localhost:5432/scormflow?schema=public
REDIS_URL=redis://localhost:6379
PORT=3000
```

### ขั้นตอนที่ 2: รัน PostgreSQL Database
เปิด container PostgreSQL ใน background:
```bash
docker compose -f docker/db.yml up -d
```
> รอจนกว่า container จะ healthy (ตรวจสอบด้วย `docker compose -f docker/db.yml ps`)

### ขั้นตอนที่ 3: รัน Redis Cache
เปิด container Redis ใน background:
```bash
docker compose -f docker/redis.yml up -d
```

### ขั้นตอนที่ 4: Migrate Database Schema
ติดตั้ง dependencies และซิงค์โครงสร้างฐานข้อมูลผ่าน Prisma:
```bash
pnpm install
# หรือซิงค์ schema โดยตรง
pnpm exec prisma db push
```

### ขั้นตอนที่ 5: เริ่มต้นรัน Engine (Dev Server)
รัน SCORM Engine ในโหมด Development (Hot Reload ผ่าน tsx):
```bash
pnpm dev
# หรือ npm run dev
```
Engine จะพร้อมใช้งานที่ `http://localhost:3000`

---

## 3. ลำดับการรันแบบ Full Docker Container

เหมาะสำหรับทดสอบการทำงานของระบบทั้งหมดใน Container เสมือน Production

### ขั้นตอนที่ 1: สั่งรันทุก Service พร้อมกัน
คำสั่งนี้จะรัน `postgres`, `redis` และ build/start `engine` โดยอัตโนมัติตาม dependency:
```bash
docker compose -f docker/docker-compose.yml up -d --build
```

### ขั้นตอนที่ 2: รัน Database Migration
```bash
npm run db:migrate:deploy
```
*(หรือรันคำสั่ง migrate จากบนเครื่อง Host หลังจาก DB healthy)*

### ขั้นตอนที่ 3: ดู Log การทำงานของ Engine
```bash
docker compose -f docker/docker-compose.yml logs -f engine
```

---

## 4. คำสั่งจัดการและการตรวจสอบสถานะ (Useful Commands)

### ตรวจสอบสถานะ Service และ Healthcheck
```bash
# ตรวจสอบสถานะ Postgres
docker compose -f docker/db.yml ps

# ตรวจสอบสถานะ Redis
docker compose -f docker/redis.yml ps

# ทดสอบ Endpoint Liveness & Readiness
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

### เปิด Prisma Studio (GUI จัดการข้อมูลใน Database)
```bash
npm run db:studio
```

### การหยุดการทำงาน (Stop & Down)

- **หยุดเฉพาะ Redis:**
  ```bash
  docker compose -f docker/redis.yml down
  ```

- **หยุดเฉพาะ Database:**
  ```bash
  docker compose -f docker/db.yml down
  ```

- **หยุดทั้งระบบพร้อมกัน (Full Stack):**
  ```bash
  docker compose -f docker/docker-compose.yml down
  ```
