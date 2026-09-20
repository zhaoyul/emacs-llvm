import assert from "node:assert/strict";
import test from "node:test";
import { ContentLengthFramer, encodeContentLengthFrame } from "../src/framing.mjs";

test("Content-Length framing accepts partial and adjacent frames", () => {
  const first = encodeContentLengthFrame({ id: 1, value: "alpha" });
  const second = encodeContentLengthFrame({ id: 2, value: "beta" });
  const framer = new ContentLengthFramer();
  const midpoint = Math.floor(first.length / 2);
  assert.deepEqual(framer.push(first.subarray(0, midpoint)), []);
  const values = framer.push(Buffer.concat([first.subarray(midpoint), second])).map((body) => JSON.parse(body.toString("utf8")));
  assert.deepEqual(values, [{ id: 1, value: "alpha" }, { id: 2, value: "beta" }]);
});

test("Content-Length framing rejects duplicate and oversized headers", () => {
  const duplicate = Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", "ascii");
  assert.throws(() => new ContentLengthFramer().push(duplicate), /duplicate/i);
  const oversized = Buffer.from("Content-Length: 5\r\n\r\nhello", "ascii");
  assert.throws(() => new ContentLengthFramer({ maximumMessageBytes: 4 }).push(oversized), /exceeds/i);
});
