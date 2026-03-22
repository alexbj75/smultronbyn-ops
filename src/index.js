import cron from "node-cron";
import { execSync } from "child_process";
import { runStockCheck } from "./stock-monitor/StockMonitor.js";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";

// --- Startup-validering ---
const requiredVars = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASS",
  "MINIO_ENDPOINT",
  "MINIO_ACCESS_KEY",
];
const missing = requiredVars.filter((v) => !process.env[v]);

// MINIO_SECRET_KEY kan levereras antingen direkt eller base64-encodad (MINIO_SECRET_KEY_B64).
// Base64-encoding behovs nar vardet innehaller shell-metacharacter som '!' (t.ex. Smultronbyn2026!)
// som OSC parameter store kan korrumpera vid injektion i shell-miljön.
const rawSecretKey = process.env.MINIO_SECRET_KEY_B64
  ? Buffer.from(process.env.MINIO_SECRET_KEY_B64, "base64").toString()
  : process.env.MINIO_SECRET_KEY;

if (!rawSecretKey) {
  missing.push("MINIO_SECRET_KEY (or MINIO_SECRET_KEY_B64)");
}

if (missing.length > 0) {
  console.error(`[STARTUP] VARNING: Saknade env-vars: ${missing.join(", ")}`);
  console.error(
    "[STARTUP] Backuper kommer att misslyckas. Kontrollera parameter store smultronbynops.",
  );
}

// --- S3-klient ---
const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || "",
    secretAccessKey: rawSecretKey || "",
  },
  forcePathStyle: true,
});

const BUCKET = "smultronbyn-backup";
const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT || "10586";
const DB_NAME = process.env.DB_NAME;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;

async function runBackup() {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const filename = `/tmp/backup-${dateStr}.sql`;
  const gzFilename = `${filename}.gz`;
  const s3Key = `daily/backup-${dateStr}.sql.gz`;

  console.log(`[${now.toISOString()}] Startar backup...`);

  try {
    // Validera att vi har allt vi behover
    if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASS) {
      throw new Error(
        "Databasvariabler saknas (DB_HOST/DB_NAME/DB_USER/DB_PASS). Avbryter.",
      );
    }

    // pg_dump med 120 sekunders timeout
    execSync(
      `PGPASSWORD="${DB_PASS}" pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -f ${filename}`,
      { stdio: "inherit", timeout: 120000 },
    );
    console.log("pg_dump klar");

    // Gzip
    await pipeline(
      createReadStream(filename),
      createGzip(),
      createWriteStream(gzFilename),
    );
    console.log("Gzip klar");

    // Upload till MinIO
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: createReadStream(gzFilename),
        ContentType: "application/gzip",
      }),
    );
    console.log(`Uploadad till MinIO: ${s3Key}`);

    // Veckovis backup (mandagar)
    if (now.getDay() === 1) {
      const weekNum = getISOWeek(now);
      const weekKey = `weekly/backup-${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}.sql.gz`;
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: weekKey,
          Body: createReadStream(gzFilename),
          ContentType: "application/gzip",
        }),
      );
      console.log(`Veckobackup: ${weekKey}`);
    }

    // Retention: behall 7 dagliga
    await cleanupOldBackups("daily/", 7);

    // Retention: behall 4 veckovisa
    await cleanupOldBackups("weekly/", 4);

    console.log(`[${new Date().toISOString()}] Backup klar!`);
  } catch (err) {
    // VIKTIGT: Logga felet men AVSLUTA INTE processen.
    // Cron-jobbet ska overleva och forsoka igen nasta natt.
    console.error(
      `[${new Date().toISOString()}] BACKUP MISSLYCKADES:`,
      err.message || err,
    );
  } finally {
    if (existsSync(filename)) unlinkSync(filename);
    if (existsSync(gzFilename)) unlinkSync(gzFilename);
  }
}

async function cleanupOldBackups(prefix, keepCount) {
  try {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }),
    );
    const objects = (res.Contents || []).sort((a, b) =>
      a.Key.localeCompare(b.Key),
    );
    const toDelete = objects.slice(0, Math.max(0, objects.length - keepCount));
    for (const obj of toDelete) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
      console.log(`Raderade gammal backup: ${obj.Key}`);
    }
  } catch (err) {
    // Retention-fel far inte krascha jobbet -- logga och fortsatt
    console.error(
      `Retention-rensning misslyckades for ${prefix}:`,
      err.message || err,
    );
  }
}

// Beraknar ISO-veckonummer (ISO 8601) korrekt.
// Den gamla implementationen anvande Math.ceil(date.getDate() / 7) vilket ger
// veckans ordning inom månaden (1-5), INTE det globala ISO-veckonumret.
function getISOWeek(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Backup: kör kl. 03:00 varje natt (UTC)
cron.schedule("0 3 * * *", runBackup);
console.log("Backup-cron aktiv. Kör dagligen kl. 03:00 UTC.");

// Lagerkoll: kör kl. 05:00 varje natt (UTC)
cron.schedule("0 5 * * *", () => {
  runStockCheck().catch((err) => {
    // runStockCheck loggar och kastar vid fatalt fel.
    // Cron-jobbet ska överleva och försöka igen nästa natt.
    console.error("[StockMonitor] Cron-körning misslyckades:", err.message);
  });
});
console.log("Lagerkoll-cron aktiv. Kör dagligen kl. 05:00 UTC.");

// Kör omedelbart vid start (for verifiering)
if (process.env.RUN_NOW === "true") {
  runBackup();
}
if (process.env.RUN_STOCK_CHECK_NOW === "true") {
  runStockCheck().catch((err) => {
    console.error("[StockMonitor] Manuell körning misslyckades:", err.message);
  });
}
