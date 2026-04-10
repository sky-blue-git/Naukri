import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { withRetries, wait } from "./retry.js";
import { normalizeUrl } from "./storage.js";

const JOB_CARD_SELECTORS = [
  "div.srp-jobtuple-wrapper",
  "article.jobTuple",
  "div.jobTuple",
  "div[data-job-id]",
  "div[class*='jobTuple']",
  "div[class*='srp-jobtuple-wrapper']",
];

const PROFILE_SELECTORS = [
  "a[title*='Profile']",
  "a[href*='profile']",
  "img[alt*='profile']",
  "div[class*='nI-gNb-icon-img']",
  "div[class*='user-name']",
];

const APPLY_BUTTON_SELECTORS = [
  "button:has-text('Apply')",
  "a:has-text('Apply')",
  "button:has-text('Quick Apply')",
  "button:has-text('Apply on company site')",
  "a:has-text('Apply on company site')",
];

export class NaukriAutoApplyAgent {
  constructor({ rootDir, store, logger, io, config = {} }) {
    this.rootDir = rootDir;
    this.store = store;
    this.logger = logger;
    this.io = io;
    this.config = {
      maxJobsToProcess: Number(
        process.env.MAX_JOBS ?? config.maxJobsToProcess ?? 100,
      ),
      applyIntervalMs: parseNumber(
        process.env.APPLY_INTERVAL_MS,
        config.applyIntervalMs,
        3000,
      ),
      excludedCompanies: parseList(
        process.env.EXCLUDED_COMPANIES,
        config.excludedCompanies,
        ["accenture", "tcs"],
      ),
      requiredKeywords: parseList(
        process.env.REQUIRED_KEYWORDS,
        config.requiredKeywords,
        ["react", "react native", "nodeJs", "nextJs", "frontend", "full stack"],
      ),
      enforceKeywordCheck: parseBoolean(
        process.env.ENFORCE_KEYWORD_CHECK,
        config.enforceKeywordCheck,
        true,
      ),
      manualModeTrustFilters: parseBoolean(
        process.env.MANUAL_MODE_TRUST_FILTERS,
        config.manualModeTrustFilters,
        true,
      ),
      formDefaults: {
        noticePeriod: process.env.NOTICE_PERIOD ?? "Immediate",
        currentSalary: process.env.CURRENT_SALARY ?? "0",
        expectedSalary: process.env.EXPECTED_SALARY ?? "4",
        preferredLocation: process.env.PREFERRED_LOCATION ?? "Bengaluru",
        experience: process.env.EXPERIENCE ?? "1",
        graduationYear: process.env.GRADUATION_YEAR ?? "2023",
        gender: process.env.GENDER ?? "Male",
        ...config.formDefaults,
      },
    };
    this.sessionSeen = new Set();
    this.stats = {
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      external: 0,
      skipReasons: {},
    };
    this.filterMode = "default";
    this.context = null;
    this.page = null;
  }

  async run() {
    await this.launchBrowser();
    try {
      await this.handleLogin();
      await this.setupFilters();
      await this.iterateJobListings();
    } finally {
      if (this.context) {
        await this.context.close();
      }
    }
    return this.stats;
  }

  async launchBrowser() {
    const profilePath = path.join(this.rootDir, ".naukri-browser-profile");
    this.context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: null,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled"
      ],
    });
    this.context.setDefaultTimeout(15000);
    this.page = this.context.pages()[0] || (await this.context.newPage());
  }

  async handleLogin() {
    console.log("\nSTEP 1: Login handling");
    await this.safeGoto(
      this.page,
      "https://www.naukri.com/",
      "Open Naukri homepage",
    );
    await this.safeGoto(
      this.page,
      "https://www.naukri.com/nlogin/login",
      "Open Naukri login page",
    );
    console.log("Please complete login manually in the opened browser window.");
    console.log("Automation will resume once login is detected.");

    let reminderTimestamp = Date.now();
    while (true) {
      if (await this.isLoggedIn()) {
        console.log("Login detected. Continuing automation.");
        break;
      }
      if (Date.now() - reminderTimestamp >= 15000) {
        console.log("Still waiting for login completion...");
        reminderTimestamp = Date.now();
      }
      await wait(2000);
    }
  }

  async isLoggedIn() {
    const currentUrl = this.page.url();
    const isOnLoginUrl = /nlogin\/login/i.test(currentUrl);

    let profileVisible = false;
    for (const selector of PROFILE_SELECTORS) {
      const visible = await this.page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        profileVisible = true;
        break;
      }
    }

    const hasSessionCookie = await this.context
      .cookies()
      .then((cookies) =>
        cookies.some(
          (cookie) =>
            cookie.domain.includes("naukri.com") &&
            /(auth|token|session|naukri)/i.test(cookie.name),
        ),
      )
      .catch(() => false);

    if (profileVisible) {
      return true;
    }
    if (!isOnLoginUrl && hasSessionCookie) {
      return true;
    }
    return false;
  }

  async setupFilters() {
    console.log("\nSTEP 2: Filter setup");
    const modify = await this.io.askYesNo(
      "Do you want to modify filters? (Yes/No): ",
    );
    if (modify) {
      this.filterMode = "manual";
      await this.openDefaultSearchLanding();
      console.log("Apply filters manually on the webpage.");
      await this.io.waitForExact(
        'Type "Filters applied" to continue: ',
        /^filters applied$/i,
      );
      const manualState = await this.captureFilterState("manual");
      console.log(`Captured manual filter state: ${manualState.url}`);
      this.printRuntimePolicy();
      return;
    }

    this.filterMode = "default";
    await this.applyDefaultFiltersProgrammatically();
    const defaultState = await this.captureFilterState("default");
    console.log(`Default filters applied on: ${defaultState.url}`);
    this.printRuntimePolicy();
  }

  async openDefaultSearchLanding() {
    const url = this.buildDefaultSearchUrl();
    await this.safeGoto(this.page, url, "Open jobs listing");
  }

  buildDefaultSearchUrl() {
    const keywords = encodeURIComponent(
      "Frontend Developer Full Stack Developer React React Native NodeJs NextJs",
    );
    return `https://www.naukri.com/jobs-in-india?k=${keywords}&experience=0&jobAge=1`;
  }

  async applyDefaultFiltersProgrammatically() {
    await this.openDefaultSearchLanding();

    const experienceApplied =
      (await this.clickFilterByText(/0\s*-\s*1\s*Yrs/i)) ||
      (await this.clickFilterByText(/0 to 1/i));

    const freshnessApplied =
      (await this.clickFilterByText(/Last\s*1\s*Day/i)) ||
      (await this.clickFilterByText(/1\s*Day/i));

    if (!experienceApplied) {
      console.log(
        "Could not confirm Experience filter by selector. URL fallback remains active.",
      );
    }
    if (!freshnessApplied) {
      console.log(
        "Could not confirm Freshness filter by selector. URL fallback remains active.",
      );
    }
  }

  async clickFilterByText(pattern) {
    const target = this.page
      .locator("label,button,a,span,div")
      .filter({ hasText: pattern })
      .first();
    const count = await target.count().catch(() => 0);
    if (!count) {
      return false;
    }
    const visible = await target.isVisible().catch(() => false);
    if (!visible) {
      return false;
    }
    const clicked = await withRetries(
      async () => {
        await target.scrollIntoViewIfNeeded();
        await target.click({ timeout: 10000 });
      },
      { label: `Apply filter ${pattern}`, retries: 3, delayMs: 800 },
    )
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      return false;
    }
    await wait(1200);
    return true;
  }

  async captureFilterState(mode) {
    const snapshot = {
      mode,
      capturedAt: new Date().toISOString(),
      url: this.page.url(),
      filters: await this.page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            "[class*='chip'], [class*='tag'], [class*='selected'], [class*='filter']",
          ),
        );
        const values = [];
        for (const node of nodes) {
          const text = node.textContent?.replace(/\s+/g, " ").trim();
          if (!text || text.length > 80) {
            continue;
          }
          if (!values.includes(text)) {
            values.push(text);
          }
        }
        return values.slice(0, 40);
      }),
    };
    const statePath = path.join(this.rootDir, "filter_state_snapshot.json");
    await fs
      .writeFile(statePath, JSON.stringify(snapshot, null, 2), "utf-8")
      .catch(() => null);
    return snapshot;
  }

  async iterateJobListings() {
    console.log(
      "\nSTEP 3-8: Job iteration, apply logic, retries, and failure handling",
    );
    let pageIndex = 1;
    while (this.stats.processed < this.config.maxJobsToProcess) {
      await this.waitForJobCardsToLoad();
      console.log(`Processing listing page ${pageIndex}...`);

      await this.processVisibleJobsOnCurrentPage();
      if (this.stats.processed >= this.config.maxJobsToProcess) {
        console.log("Processing limit reached.");
        break;
      }

      const moved = await this.goToNextPage();
      if (!moved) {
        console.log("No more pages/jobs available.");
        break;
      }
      pageIndex += 1;
    }
  }

  async waitForJobCardsToLoad() {
    await withRetries(
      async () => {
        for (const selector of JOB_CARD_SELECTORS) {
          const locator = this.page.locator(selector).first();
          const visible = await locator.isVisible().catch(() => false);
          if (visible) {
            return;
          }
        }
        throw new Error("Job cards are not visible yet");
      },
      {
        label: "Wait for job cards",
        retries: 3,
        delayMs: 1500,
      },
    ).catch(() => null);
  }

  async processVisibleJobsOnCurrentPage() {
    let previousCount = -1;
    while (this.stats.processed < this.config.maxJobsToProcess) {
      const cardsLocator = await this.getJobCardsLocator();
      const count = await cardsLocator.count().catch(() => 0);
      if (count === 0) {
        break;
      }

      for (let index = 0; index < count; index += 1) {
        if (this.stats.processed >= this.config.maxJobsToProcess) {
          return;
        }
        const card = cardsLocator.nth(index);
        const job = await this.extractJobFromCard(card);
        if (!job) {
          continue;
        }

        const key = this.buildJobKey(job);
        if (this.sessionSeen.has(key)) {
          continue;
        }
        this.sessionSeen.add(key);
        await this.processSingleJob(job);
      }

      if (count <= previousCount) {
        const loaded = await this.tryLoadMoreJobs(count);
        if (!loaded) {
          break;
        }
      } else {
        previousCount = count;
      }
    }
  }

  async getJobCardsLocator() {
    for (const selector of JOB_CARD_SELECTORS) {
      const locator = this.page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        return locator;
      }
    }
    return this.page.locator("a[href*='job-listings']").locator("..");
  }

  async extractJobFromCard(card) {
    try {
      const raw = await card.evaluate((node) => {
        const findFirst = (selectors) => {
          for (const selector of selectors) {
            const element = node.querySelector(selector);
            if (element) {
              return element;
            }
          }
          return null;
        };

        const link = findFirst([
          "a[href*='job-listings']",
          "a[title][href]",
          "a[href]",
        ]);
        const titleElement = findFirst([
          "a[title]",
          "[class*='title']",
          "[class*='jobTitle']",
        ]);
        const companyElement = findFirst([
          "a.comp-name",
          ".comp-name",
          "[class*='comp-name']",
          "[class*='company']",
        ]);

        return {
          title: (link?.textContent || titleElement?.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
          url: link?.href || "",
          company: (companyElement?.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
          explicitId:
            node.getAttribute("data-job-id") ||
            node.getAttribute("id") ||
            link?.getAttribute("data-job-id") ||
            "",
          rawDataText: node.textContent || "",
        };
      });

      const jobUrl = normalizeUrl(raw.url);
      const jobId = this.extractJobId(jobUrl, raw.explicitId);
      const title = raw.title || "Unknown title";
      const company = raw.company || "Unknown company";
      
      let minExp = 0;
      const expMatch = raw.rawDataText.match(/(\d+)\s*-\s*(\d+)\s*yrs/i) || raw.rawDataText.match(/(\d+)\s*-\s*(\d+)\s*years/i);
      if (expMatch) {
         minExp = parseInt(expMatch[1], 10);
      }
      
      return {
        jobId,
        jobUrl,
        title,
        company,
        minExp
      };
    } catch {
      return null;
    }
  }

  extractJobId(url, explicitId) {
    if (explicitId) {
      return String(explicitId).trim();
    }
    if (!url) {
      return "";
    }

    const numericTailMatch = url.match(/-(\d+)(?:\?|$)/);
    if (numericTailMatch?.[1]) {
      return numericTailMatch[1];
    }

    const queryIdMatch = url.match(/[?&](?:jobId|jk|id)=(\d+)/i);
    if (queryIdMatch?.[1]) {
      return queryIdMatch[1];
    }

    return "";
  }

  buildJobKey(job) {
    return job.jobId || job.jobUrl || `${job.title}|${job.company}`;
  }

  async processSingleJob(job) {
    this.stats.processed += 1;
    const logPayload = {
      jobTitle: job.title,
      company: job.company,
      jobId: job.jobId || null,
      jobUrl: job.jobUrl || null,
    };

    if (!job.jobUrl) {
      this.stats.failed += 1;
      await this.logger.logFailed({ ...logPayload, reason: "Job URL missing" });
      return;
    }

    if (this.store.has(job.jobId, job.jobUrl)) {
      this.stats.skipped += 1;
      const reason = "Already applied (persistent store)";
      this.incrementSkipReason(reason);
      await this.logger.logSkipped({ ...logPayload, reason });
      return;
    }

    if (this.isExcludedCompany(job.company)) {
      this.stats.skipped += 1;
      const reason = "Company is excluded";
      this.incrementSkipReason(reason);
      await this.logger.logSkipped({ ...logPayload, reason });
      return;
    }

    if (this.shouldSkipByKeyword(job)) {
      this.stats.skipped += 1;
      const reason = `Keyword/Experience mismatch`;
      this.incrementSkipReason(reason);
      await this.logger.logSkipped({ ...logPayload, reason });
      return;
    }

    const result = await this.applyToJob(job);
    if (result.status === "applied") {
      this.stats.applied += 1;
      await this.store.add({ jobId: job.jobId, jobUrl: job.jobUrl });
      await this.logger.logApplied({
        ...logPayload,
        reason: result.reason || "Applied successfully",
      });
      console.log(`[APPLIED] ${job.title} | ${job.company}`);
      await this.waitApplyInterval();
      return;
    }

    if (result.status === "external") {
      this.stats.external += 1;
      await this.logger.logExternalUrl(result.externalUrl);
      const reason = "External application redirect detected";
      this.incrementSkipReason(reason);
      await this.logger.logSkipped({
        ...logPayload,
        reason,
      });
      console.log(
        `[EXTERNAL] ${job.title} | ${job.company} | ${result.externalUrl}`,
      );
      await this.waitApplyInterval();
      return;
    }

    if (result.status === "skip_and_mark_applied") {
      this.stats.skipped += 1;
      await this.store.add({ jobId: job.jobId, jobUrl: job.jobUrl });
      const reason = result.reason || "Already applied on portal";
      this.incrementSkipReason(reason);
      await this.logger.logSkipped({
        ...logPayload,
        reason,
      });
      console.log(`[SKIP] ${job.title} | ${job.company} | ${reason}`);
      await this.waitApplyInterval();
      return;
    }

    this.stats.failed += 1;
    await this.logger.logFailed({
      ...logPayload,
      reason: result.reason || "Unknown apply failure",
    });
    console.log(
      `[FAILED] ${job.title} | ${job.company} | ${result.reason || "Unknown apply failure"}`,
    );
    await this.waitApplyInterval();
  }

  isExcludedCompany(company) {
    if (!this.config.excludedCompanies.length) {
      return false;
    }
    return this.config.excludedCompanies.some((excluded) =>
      company.toLowerCase().includes(excluded),
    );
  }

  shouldSkipByKeyword(job) {
    const userMaxExp = parseInt(this.config.formDefaults.experience, 10) || 1;
    if (job.minExp && job.minExp > userMaxExp + 1) {
       return true;
    }

    if (!this.config.enforceKeywordCheck) {
      return false;
    }
    if (this.filterMode === "manual" && this.config.manualModeTrustFilters) {
      return false;
    }
    return !this.matchesKeywords(job);
  }

  matchesKeywords(job) {
    const haystack = `${job.title} ${job.jobUrl}`.toLowerCase();
    return this.config.requiredKeywords.some((keyword) =>
      haystack.includes(keyword),
    );
  }

  incrementSkipReason(reason) {
    this.stats.skipReasons[reason] = (this.stats.skipReasons[reason] ?? 0) + 1;
  }

  printRuntimePolicy() {
    const excluded = this.config.excludedCompanies.length
      ? this.config.excludedCompanies.join(", ")
      : "none";
    const keywordMode = !this.config.enforceKeywordCheck
      ? "disabled"
      : this.filterMode === "manual" && this.config.manualModeTrustFilters
        ? "trusted manual filters (no hard keyword gate)"
        : `strict (${this.config.requiredKeywords.join(", ")})`;
    console.log(`Runtime policy -> Excluded companies: ${excluded}`);
    console.log(`Runtime policy -> Keyword check: ${keywordMode}`);
    console.log(
      `Runtime policy -> Delay between apply attempts: ${this.config.applyIntervalMs}ms`,
    );
  }

  async waitApplyInterval() {
    // Increase base safety to minimum 5s if default is lower, plus severe randomization 4s to 25s
    const baseInterval = Math.max(this.config.applyIntervalMs, 5000); 
    const randomExtraMs = Math.floor(Math.random() * 20000) + 4000; 
    await wait(baseInterval + randomExtraMs);
  }

  async applyToJob(job) {
    const jobPage = await this.context.newPage();
    jobPage.setDefaultTimeout(15000);

    try {
      await this.safeGoto(jobPage, job.jobUrl, `Open job URL ${job.jobUrl}`);

      const alreadyApplied = await this.isAlreadyAppliedOnPortal(jobPage);
      if (alreadyApplied) {
        return {
          status: "skip_and_mark_applied",
          reason: "Already applied on Naukri portal",
        };
      }

      const applyLocator = await withRetries(
        async () => {
          const located = await this.findApplyLocator(jobPage);
          if (!located) {
            throw new Error("Apply button not found yet");
          }
          return located;
        },
        { label: "Find Apply button", retries: 3, delayMs: 1200 },
      ).catch(() => null);
      if (!applyLocator) {
        return {
          status: "failed",
          reason: "Apply button not found",
        };
      }

      const clickOutcome = await this.clickApplyAndHandleRedirects(
        jobPage,
        applyLocator,
      );
      if (clickOutcome.status === "external") {
        return clickOutcome;
      }
      if (clickOutcome.status === "failed") {
        return clickOutcome;
      }

      const formOutcome = await this.handleApplyFormFlow(jobPage);
      return formOutcome;
    } catch (error) {
      return {
        status: "failed",
        reason: `Unhandled apply error: ${error.message}`,
      };
    } finally {
      await jobPage.close().catch(() => null);
    }
  }

  async isAlreadyAppliedOnPortal(page) {
    const checks = [
      /already applied/i,
      /\bapplied\b/i,
      /application submitted/i,
    ];
    for (const regex of checks) {
      const seen = await page
        .getByText(regex)
        .first()
        .isVisible()
        .catch(() => false);
      if (seen) {
        return true;
      }
    }
    return false;
  }

  async findApplyLocator(page) {
    for (const selector of APPLY_BUTTON_SELECTORS) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        return locator;
      }
    }
    return null;
  }

  async clickApplyAndHandleRedirects(page, applyLocator) {
    const ctaCandidates = await Promise.all([
      applyLocator.getAttribute("href").catch(() => null),
      applyLocator.getAttribute("data-href").catch(() => null),
      applyLocator.getAttribute("data-url").catch(() => null),
    ]);

    const popupPromise = page
      .waitForEvent("popup", { timeout: 7000 })
      .catch(() => null);
    const clicked = await withRetries(
      async () => {
        await applyLocator.scrollIntoViewIfNeeded();
        await applyLocator.click({ timeout: 12000 });
      },
      {
        label: "Click Apply button",
        retries: 3,
        delayMs: 900,
      },
    )
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      return {
        status: "failed",
        reason: "Apply button click failed after retries",
      };
    }

    await wait(2500);

    const popupPage = await popupPromise;
    if (popupPage) {
      await popupPage.waitForLoadState("domcontentloaded").catch(() => null);
      await popupPage
        .waitForLoadState("networkidle", { timeout: 5000 })
        .catch(() => null);
      const popupUrl = popupPage.url();
      const popupAnchor = await popupPage
        .locator("a[href]")
        .first()
        .getAttribute("href")
        .catch(() => null);
      const externalUrl = this.resolveValidExternalUrl(
        [...ctaCandidates, popupAnchor, popupUrl],
        page.url(),
      );
      if (externalUrl) {
        await popupPage.close().catch(() => null);
        return {
          status: "external",
          externalUrl,
        };
      }
      await popupPage.close().catch(() => null);
    }

    const currentUrl = page.url();
    const externalUrl = this.resolveValidExternalUrl(
      [...ctaCandidates, currentUrl],
      page.url(),
    );
    if (externalUrl) {
      return {
        status: "external",
        externalUrl,
      };
    }

    return { status: "ok" };
  }

  resolveValidExternalUrl(candidates, baseUrl) {
    for (const candidate of candidates) {
      const normalized = this.normalizePossibleUrl(candidate, baseUrl);
      if (!normalized) {
        continue;
      }
      const unwrapped = this.unwrapRedirectUrl(normalized);
      if (!unwrapped) {
        continue;
      }
      if (!this.isValidExternalHttpUrl(unwrapped)) {
        continue;
      }
      return unwrapped;
    }
    return "";
  }

  normalizePossibleUrl(candidate, baseUrl) {
    if (!candidate || typeof candidate !== "string") {
      return "";
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      return "";
    }
    if (/^(javascript:|about:|data:|mailto:|tel:)/i.test(trimmed)) {
      return "";
    }
    try {
      const resolved = new URL(trimmed, baseUrl);
      resolved.hash = "";
      return resolved.toString();
    } catch {
      return "";
    }
  }

  unwrapRedirectUrl(candidateUrl) {
    let current = candidateUrl;
    for (let depth = 0; depth < 3; depth += 1) {
      try {
        const parsed = new URL(current);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes("naukri.com")) {
          return parsed.toString();
        }
        const keys = [
          "url",
          "redirect",
          "redirecturl",
          "target",
          "targeturl",
          "destination",
          "dest",
          "to",
          "applyurl",
          "out",
          "u",
          "link",
        ];
        let next = "";
        for (const key of keys) {
          const value = parsed.searchParams.get(key);
          if (value && value.trim()) {
            next = value.trim();
            break;
          }
        }
        if (!next) {
          return "";
        }
        current = this.normalizePossibleUrl(next, parsed.toString());
        if (!current) {
          return "";
        }
      } catch {
        return "";
      }
    }
    return "";
  }

  isValidExternalHttpUrl(candidateUrl) {
    try {
      const parsed = new URL(candidateUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      if (!host || host.includes("naukri.com")) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async handleApplyFormFlow(page) {
    if (await this.isAlreadyAppliedOnPortal(page)) {
      return { status: "applied", reason: "Application confirmed on portal" };
    }

    const fillResult = await this.autoFillKnownFields(page);
    if (fillResult.filledAny) {
      await this.tryClickSubmitButtons(page);
      await wait(2000);
    }

    if (await this.isAlreadyAppliedOnPortal(page)) {
      return {
        status: "applied",
        reason: "Application submitted after auto-fill",
      };
    }

    if (fillResult.manualRequired) {
      console.log("Manual input required for dynamic/unknown questions.");
      await this.io.waitForEnter(
        "Complete and submit in browser, then press Enter here: ",
      );
      if (await this.isAlreadyAppliedOnPortal(page)) {
        return {
          status: "applied",
          reason: "Application submitted after manual input",
        };
      }
      return {
        status: "failed",
        reason: "Manual step completed but submission not detected",
      };
    }

    const applyButtonStillVisible = await this.findApplyLocator(page)
      .then(Boolean)
      .catch(() => false);
    if (!applyButtonStillVisible) {
      return {
        status: "applied",
        reason: "Apply CTA not visible after flow",
      };
    }

    return {
      status: "failed",
      reason: "Unable to confirm successful submission",
    };
  }

  async autoFillKnownFields(page) {
    const payload = this.config.formDefaults;
    const result = await page
      .evaluate((defaults) => {
        const cleaned = (text) =>
          (text || "").toLowerCase().replace(/\s+/g, " ").trim();
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const fire = (el, val) => {
          if (val !== undefined) {
             const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
             const nativeTextAreaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
             
             if (el instanceof HTMLInputElement && nativeInputSetter) {
                nativeInputSetter.call(el, val);
             } else if (el instanceof HTMLTextAreaElement && nativeTextAreaSetter) {
                nativeTextAreaSetter.call(el, val);
             } else {
                el.value = val;
             }
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        };
        const labelFor = (field) => {
          if (field.id) {
            const direct = document.querySelector(`label[for="${field.id}"]`);
            if (direct) {
              return direct.textContent || "";
            }
          }
          const wrappingLabel = field.closest("label");
          if (wrappingLabel) {
            return wrappingLabel.textContent || "";
          }
          const parent = field.parentElement;
          if (parent) {
            const siblingLabel = parent.querySelector("label");
            if (siblingLabel) {
              return siblingLabel.textContent || "";
            }
          }
          return "";
        };

        const fields = Array.from(
          document.querySelectorAll("input, textarea, select"),
        ).filter((field) => {
          if (
            !(
              field instanceof HTMLInputElement ||
              field instanceof HTMLTextAreaElement ||
              field instanceof HTMLSelectElement
            )
          ) {
            return false;
          }
          if (field.disabled || field.readOnly) {
            return false;
          }
          if (!isVisible(field)) {
            return false;
          }
          const type =
            field instanceof HTMLInputElement
              ? (field.type || "").toLowerCase()
              : "";
          if (
            [
              "hidden",
              "checkbox",
              "radio",
              "file",
              "submit",
              "button",
            ].includes(type)
          ) {
            return false;
          }
          return true;
        });

        const definitions = [
          {
            key: "noticePeriod",
            patterns: ["notice period", "serving notice", "np"],
            value: defaults.noticePeriod,
          },
          {
            key: "currentSalary",
            patterns: [
              "current salary",
              "current ctc",
              "present ctc",
              "current annual",
              "lakhs",
              "lacs",
              "ctc in lacs",
              "ctc in lakhs"
            ],
            value: defaults.currentSalary,
          },
          {
            key: "expectedSalary",
            patterns: [
              "expected salary",
              "expected ctc",
              "expected annual",
              "desired salary",
              "expected ctc in lacs",
              "expected ctc in lakhs"
            ],
            value: defaults.expectedSalary,
          },
          {
            key: "preferredLocation",
            patterns: [
              "preferred location",
              "location preference",
              "preferred city",
              "preferred place",
            ],
            value: defaults.preferredLocation,
          },
          {
            key: "experience",
            patterns: [
              "experience",
              "total experience",
              "years of experience",
              "overall experience",
              "work experience",
            ],
            value: defaults.experience,
          },
          {
            key: "graduationYear",
            patterns: [
              "graduation year",
              "passing year",
              "year of passing",
              "year of graduation",
              "completion year",
              "batch",
            ],
            value: defaults.graduationYear,
          },
          {
            key: "willingness",
            patterns: [
              "willing",
              "relocate",
              "shifts",
              "rotational",
              "ready to",
              "immediate joiner",
            ],
            value: "yes",
          },
          {
            key: "gender",
            patterns: ["gender", "sex"],
            value: defaults.gender,
          },
        ];

        const filledKeys = [];

        for (const field of fields) {
          const attrs = [
            field.getAttribute("name"),
            field.getAttribute("id"),
            field.getAttribute("placeholder"),
            field.getAttribute("aria-label"),
            labelFor(field),
            field.closest("div, section, form")?.textContent?.slice(0, 200),
          ]
            .filter(Boolean)
            .join(" ");
          const fieldText = cleaned(attrs);
          if (!fieldText) {
            continue;
          }

          for (const def of definitions) {
            if (!def.patterns.some((pattern) => fieldText.includes(pattern))) {
              continue;
            }

            if (field instanceof HTMLSelectElement) {
              const wanted = cleaned(def.value);
              let selected = false;
              for (const option of Array.from(field.options)) {
                if (
                  cleaned(option.textContent).includes(wanted) ||
                  cleaned(option.value).includes(wanted)
                ) {
                  field.value = option.value;
                  selected = true;
                  break;
                }
              }
              if (!selected && field.options.length > 1) {
                field.selectedIndex = 1;
              }
              fire(field, field.value);
              filledKeys.push(def.key);
              break;
            }

            const nextValue = String(def.value ?? "").trim();
            if (!nextValue) {
              break;
            }
            fire(field, nextValue);
            filledKeys.push(def.key);
            break;
          }
        }

        const requiredUnfilled = [];
        for (const field of fields) {
          const required =
            field.required || field.getAttribute("aria-required") === "true";
          if (!required) {
            continue;
          }
          const value = (field.value || "").trim();
          if (value) {
            continue;
          }
          const descriptor = cleaned(
            [
              field.getAttribute("name"),
              field.getAttribute("id"),
              field.getAttribute("placeholder"),
              labelFor(field),
            ]
              .filter(Boolean)
              .join(" "),
          );
          requiredUnfilled.push(descriptor || "unnamed-required-field");
        }

        // --- BLIND FALLBACK FILLER: Never ask for manual input ---
        for (const field of fields) {
          const value = (field.value || "").trim();
          if (value) continue;
          
          const attrs = cleaned(
             [field.getAttribute("name"), field.getAttribute("id"), field.getAttribute("placeholder"), labelFor(field)].join(" ")
          );
          
          if (attrs.includes("search") || attrs.includes("keyword")) {
             continue; // Skip site nav search bars
          }
          if (field.readOnly || field.disabled) continue;

          if (field instanceof HTMLSelectElement) {
            if (field.options.length > 1) {
               field.selectedIndex = 1; 
               fire(field, field.options[1].value);
               filledKeys.push("blind-fallback-select");
            }
          } else {
            // Give "2" for num/year questions, otherwise "Yes"
            const fallbackText = (attrs.includes("year") || attrs.includes("month") || attrs.includes("rate") || attrs.includes("ctc") || attrs.includes("salary")) ? "2" : "Yes";
            fire(field, fallbackText);
            filledKeys.push("blind-fallback-text");
          }
        }
        
        // Force array empty so the script NEVER pauses
        requiredUnfilled.length = 0;

        return {
          filledKeys: Array.from(new Set(filledKeys)),
          requiredUnfilled: Array.from(new Set(requiredUnfilled)).slice(0, 15),
        };
      }, payload)
      .catch((e) => {
        console.error("Auto-fill evaluation error:", e);
        return { filledKeys: [], requiredUnfilled: [] };
      });

    // Added explicitly handling click for 'save' or 'submit' button right inside that popup specifically for chat style popup
    try{
      const widgetSaveBtn = page.locator("button:has-text('Save'), button:has-text('Submit'), button:has-text('Continue')").last();
      const visible = await widgetSaveBtn.isVisible({timeout: 1000}).catch(()=>false);
      if(visible && result.filledKeys.length > 0) {
         await widgetSaveBtn.click({timeout: 3000}).catch(()=>null);
         await wait(1500)
      }
    } catch(e) {}

    return {
      filledAny: result.filledKeys.length > 0,
      manualRequired: result.requiredUnfilled.length > 0,
    };
  }

  async tryClickSubmitButtons(page) {
    const submitPatterns = [/submit/i, /^apply$/i, /continue/i, /save/i];
    const candidates = page.locator(
      "button, input[type='submit'], a[role='button']",
    );
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      const candidate = candidates.nth(i);
      const text = (await candidate.textContent().catch(() => "")) || "";
      const value =
        (await candidate.getAttribute("value").catch(() => "")) || "";
      const label = `${text} ${value}`.trim();
      if (!submitPatterns.some((pattern) => pattern.test(label))) {
        continue;
      }
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      await candidate.click({ timeout: 4000 }).catch(() => null);
      await wait(1200);
      break;
    }
  }

  async tryLoadMoreJobs(previousCount) {
    await this.page.mouse.wheel(0, 15000).catch(() => null);
    await wait(1500);

    const loadMore = this.page
      .locator(
        "button:has-text('Load more'), a:has-text('Load more'), button:has-text('Show more')",
      )
      .first();
    const loadMoreVisible = await loadMore.isVisible().catch(() => false);
    if (loadMoreVisible) {
      await withRetries(
        async () => {
          await loadMore.click({ timeout: 8000 });
        },
        { label: "Load more jobs", retries: 3, delayMs: 700 },
      ).catch(() => null);
      await wait(1800);
    }

    const updatedLocator = await this.getJobCardsLocator();
    const updatedCount = await updatedLocator.count().catch(() => 0);
    return updatedCount > previousCount;
  }

  async goToNextPage() {
    const beforeUrl = this.page.url();
    const beforeFirstJobKey = await this.getFirstJobKey();
    const nextCandidates = [
      this.page.getByRole("link", { name: /next/i }).first(),
      this.page.getByRole("button", { name: /next/i }).first(),
      this.page.locator("a:has-text('Next')").first(),
      this.page.locator("button:has-text('Next')").first(),
    ];

    for (const candidate of nextCandidates) {
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      const disabledAttr = await candidate
        .getAttribute("disabled")
        .catch(() => null);
      const className =
        (await candidate.getAttribute("class").catch(() => "")) || "";
      if (disabledAttr !== null || /disabled/i.test(className)) {
        continue;
      }

      const clicked = await withRetries(
        async () => {
          await candidate.scrollIntoViewIfNeeded().catch(() => null);
          await candidate.click({ timeout: 10000 });
        },
        { label: "Go to next page", retries: 3, delayMs: 900 },
      )
        .then(() => true)
        .catch(() => false);

      if (!clicked) {
        continue;
      }

      await wait(2200);
      const afterUrl = this.page.url();
      if (afterUrl !== beforeUrl) {
        return true;
      }

      const afterFirstJobKey = await this.getFirstJobKey();
      if (afterFirstJobKey && afterFirstJobKey !== beforeFirstJobKey) {
        return true;
      }
    }

    return false;
  }

  async getFirstJobKey() {
    const cards = await this.getJobCardsLocator();
    const count = await cards.count().catch(() => 0);
    if (!count) {
      return "";
    }
    const first = await this.extractJobFromCard(cards.first());
    if (!first) {
      return "";
    }
    return this.buildJobKey(first);
  }

  async safeGoto(page, url, label) {
    await withRetries(
      async () => {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 40000,
        });
      },
      {
        label,
        retries: 3,
        delayMs: 1200,
      },
    );
  }
}

function parseList(envValue, configured, defaults) {
  if (envValue !== undefined) {
    return envValue
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(configured) && configured.length) {
    return configured
      .map((value) => String(value).trim().toLowerCase())
      .filter(Boolean);
  }
  return defaults;
}

function parseBoolean(envValue, configured, fallback) {
  if (envValue !== undefined) {
    const normalized = String(envValue).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  if (typeof configured === "boolean") {
    return configured;
  }
  return fallback;
}

function parseNumber(envValue, configured, fallback) {
  if (envValue !== undefined) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
