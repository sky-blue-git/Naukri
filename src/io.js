import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export class UserIO {
  constructor() {
    this.rl = readline.createInterface({ input, output });
  }

  async ask(question) {
    return (await this.rl.question(question)).trim();
  }

  async askYesNo(question) {
    while (true) {
      const answer = (await this.ask(question)).toLowerCase();
      if (["y", "yes"].includes(answer)) {
        return true;
      }
      if (["n", "no"].includes(answer)) {
        return false;
      }
      console.log("Please answer with Yes or No.");
    }
  }

  async waitForExact(question, expectedRegex) {
    while (true) {
      const answer = await this.ask(question);
      if (expectedRegex.test(answer)) {
        return answer;
      }
      console.log("Input not recognized. Please try again.");
    }
  }

  async waitForEnter(question) {
    await this.ask(question);
  }

  close() {
    this.rl.close();
  }
}

