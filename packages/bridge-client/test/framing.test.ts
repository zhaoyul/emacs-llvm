import test from "node:test";
import assert from "node:assert/strict";
import { ContentLengthParser, encodeContentLengthFrame } from "../src/framing.js";

test("ContentLengthParser handles split headers and UTF-8 split bodies", () => {
  const parser = new ContentLengthParser();
  const value = { text: "中文 λ Emacs" };
  const frame = encodeContentLengthFrame(value);
  const cuts = [1, 7, 19, 37, frame.length - 2];
  let previous = 0;
  const output: string[] = [];
  for (const cut of [...cuts, frame.length]) {
    output.push(...parser.push(frame.subarray(previous, cut)));
    previous = cut;
  }
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]!), value);
  assert.equal(parser.bufferedBytes, 0);
});

test("ContentLengthParser handles multiple frames in one chunk", () => {
  const parser = new ContentLengthParser();
  const frame = Buffer.concat([encodeContentLengthFrame({ n: 1 }), encodeContentLengthFrame({ n: 2 })]);
  assert.deepEqual(parser.push(frame).map((text) => JSON.parse(text)), [{ n: 1 }, { n: 2 }]);
});

test("ContentLengthParser enforces byte size", () => {
  const parser = new ContentLengthParser(4);
  const frame = encodeContentLengthFrame({ abc: 1 });
  assert.throws(() => parser.push(frame), /exceeds configured size limit/);
});
