import * as fs from "node:fs";
import { splitComplete } from "./protocol";

/** Stateful, truncation-safe reader for an append-only notification file. */
export class FileTail {
  #position = 0;
  #rest = "";

  reset() {
    this.#position = 0;
    this.#rest = "";
  }

  start(file: string) {
    this.#position = fs.statSync(file).size;
    this.#rest = "";
  }

  read(file: string): string[] {
    const size = fs.statSync(file).size;
    if (size < this.#position) this.reset();
    if (size === this.#position) return [];
    const fd = fs.openSync(file, "r");
    try {
      const bytes = Buffer.alloc(size - this.#position);
      fs.readSync(fd, bytes, 0, bytes.length, this.#position);
      this.#position = size;
      const split = splitComplete(this.#rest + bytes.toString("utf8"));
      this.#rest = split.rest;
      return split.lines;
    } finally {
      fs.closeSync(fd);
    }
  }
}
