import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { jobs: [] };

export class AppliedJobsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...EMPTY_STORE };
    this.byJobId = new Set();
    this.byJobUrl = new Set();
  }

  async init() {
    await this.ensureFile();
    await this.load();
  }

  async ensureFile() {
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(EMPTY_STORE, null, 2), "utf-8");
    }
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      this.data = Array.isArray(parsed?.jobs) ? parsed : { ...EMPTY_STORE };
    } catch {
      this.data = { ...EMPTY_STORE };
    }

    this.byJobId.clear();
    this.byJobUrl.clear();
    for (const job of this.data.jobs) {
      if (job?.jobId) {
        this.byJobId.add(String(job.jobId));
      }
      if (job?.jobUrl) {
        this.byJobUrl.add(normalizeUrl(job.jobUrl));
      }
    }
  }

  has(jobId, jobUrl) {
    const urlKey = normalizeUrl(jobUrl);
    if (jobId && this.byJobId.has(String(jobId))) {
      return true;
    }
    if (urlKey && this.byJobUrl.has(urlKey)) {
      return true;
    }
    return false;
  }

  async add({ jobId, jobUrl }) {
    const normalizedUrl = normalizeUrl(jobUrl);
    if (!jobId && !normalizedUrl) {
      return;
    }
    if (this.has(jobId, normalizedUrl)) {
      return;
    }

    const record = {
      jobId: jobId ? String(jobId) : null,
      jobUrl: normalizedUrl || null,
      appliedAt: new Date().toISOString()
    };
    this.data.jobs.push(record);

    if (record.jobId) {
      this.byJobId.add(record.jobId);
    }
    if (record.jobUrl) {
      this.byJobUrl.add(record.jobUrl);
    }
    await this.save();
  }

  async save() {
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
}

export function normalizeUrl(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    if (parsed.searchParams.has("src")) {
      parsed.searchParams.delete("src");
    }
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

