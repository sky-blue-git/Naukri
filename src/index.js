import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserIO } from "./io.js";
import { AppliedJobsStore } from "./storage.js";
import { FileLogger } from "./logger.js";
import { NaukriAutoApplyAgent } from "./agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

async function main() {
  const io = new UserIO();
  const store = new AppliedJobsStore(path.join(rootDir, "applied_jobs.json"));
  const logger = new FileLogger(rootDir);

  try {
    await store.init();
    await logger.init();

    const agent = new NaukriAutoApplyAgent({
      rootDir,
      store,
      logger,
      io
    });

    const stats = await agent.run();
    console.log("\nRun complete.");
    console.log(`Processed: ${stats.processed}`);
    console.log(`Applied: ${stats.applied}`);
    console.log(`Skipped: ${stats.skipped}`);
    console.log(`Failed: ${stats.failed}`);
    console.log(`External redirects: ${stats.external}`);
    if (stats.skipReasons && Object.keys(stats.skipReasons).length) {
      console.log("Skip reasons:");
      for (const [reason, count] of Object.entries(stats.skipReasons).sort((a, b) => b[1] - a[1])) {
        console.log(`- ${reason}: ${count}`);
      }
    }
    console.log("\nOutputs:");
    console.log("- applied_jobs.json");
    console.log("- applied_jobs.log");
    console.log("- skipped_jobs.log");
    console.log("- failed_jobs.log");
    console.log("- externaljoblink.txt");
  } catch (error) {
    console.error(`Automation stopped with error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    io.close();
  }
}

main();
