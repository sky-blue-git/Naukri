import fs from "node:fs/promises";
import path from "node:path";

export class FileLogger {
  constructor(rootDir) {
    this.appliedLogPath = path.join(rootDir, "applied_jobs.log");
    this.skippedLogPath = path.join(rootDir, "skipped_jobs.log");
    this.failedLogPath = path.join(rootDir, "failed_jobs.log");
    this.externalLinksPath = path.join(rootDir, "externaljoblink.txt");
  }

  async init() {
    await Promise.all([
      this.ensureFile(this.appliedLogPath),
      this.ensureFile(this.skippedLogPath),
      this.ensureFile(this.failedLogPath),
      this.ensureFile(this.externalLinksPath)
    ]);
  }

  async ensureFile(filePath) {
    try {
      await fs.access(filePath);
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "", "utf-8");
    }
  }

  async logApplied(payload) {
    await this.appendJsonLine(this.appliedLogPath, payload);
  }

  async logSkipped(payload) {
    await this.appendJsonLine(this.skippedLogPath, payload);
  }

  async logFailed(payload) {
    await this.appendJsonLine(this.failedLogPath, payload);
  }

  async logExternalUrl(externalUrl) {
    if (!isValidHttpUrl(externalUrl)) {
      return;
    }
    await fs.appendFile(this.externalLinksPath, `${externalUrl}\n`, "utf-8");
  }

  async appendJsonLine(filePath, payload) {
    const entry = {
      timestamp: new Date().toISOString(),
      jobTitle: payload.jobTitle ?? "Unknown",
      company: payload.company ?? "Unknown",
      reason: payload.reason ?? "N/A",
      jobId: payload.jobId ?? null,
      jobUrl: payload.jobUrl ?? null
    };
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}

function isValidHttpUrl(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return false;
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
