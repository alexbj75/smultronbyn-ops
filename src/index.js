import cron from 'node-cron';
import { execSync } from 'child_process';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, unlinkSync, existsSync } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = 'smultronbyn-backups';
const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT || '10586';
const DB_NAME = process.env.DB_NAME;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;

async function runBackup() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `/tmp/backup-${dateStr}.sql`;
  const gzFilename = `${filename}.gz`;
  const s3Key = `daily/backup-${dateStr}.sql.gz`;

  console.log(`[${now.toISOString()}] Startar backup...`);

  try {
    // pg_dump
    execSync(
      `PGPASSWORD="${DB_PASS}" pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -f ${filename}`,
      { stdio: 'inherit' }
    );
    console.log('pg_dump klar');

    // Gzip
    await pipeline(
      createReadStream(filename),
      createGzip(),
      createWriteStream(gzFilename)
    );
    console.log('Gzip klar');

    // Upload till MinIO
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: createReadStream(gzFilename),
      ContentType: 'application/gzip',
    }));
    console.log(`Uploadad till MinIO: ${s3Key}`);

    // Veckovis backup (mandagar)
    if (now.getDay() === 1) {
      const weekNum = Math.ceil(now.getDate() / 7);
      const weekKey = `weekly/backup-${now.getFullYear()}-W${String(weekNum).padStart(2,'0')}.sql.gz`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: weekKey,
        Body: createReadStream(gzFilename),
        ContentType: 'application/gzip',
      }));
      console.log(`Veckobackup: ${weekKey}`);
    }

    // Retention: behall 7 dagliga
    await cleanupOldBackups('daily/', 7);

    // Retention: behall 4 veckovisa
    await cleanupOldBackups('weekly/', 4);

    console.log(`[${new Date().toISOString()}] Backup klar!`);
  } catch (err) {
    console.error('BACKUP MISSLYCKADES:', err);
    process.exit(1);
  } finally {
    if (existsSync(filename)) unlinkSync(filename);
    if (existsSync(gzFilename)) unlinkSync(gzFilename);
  }
}

async function cleanupOldBackups(prefix, keepCount) {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  const objects = (res.Contents || []).sort((a, b) => a.Key.localeCompare(b.Key));
  const toDelete = objects.slice(0, Math.max(0, objects.length - keepCount));
  for (const obj of toDelete) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
    console.log(`Raderade gammal backup: ${obj.Key}`);
  }
}

// Kor kl. 03:00 varje natt (UTC)
cron.schedule('0 3 * * *', runBackup);
console.log('Backup-cron aktiv. Kor dagligen kl. 03:00 UTC.');

// Kor omedelbart vid start (for verifiering)
if (process.env.RUN_NOW === 'true') {
  runBackup();
}
