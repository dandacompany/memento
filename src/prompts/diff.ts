import pc from "picocolors";

type DiffOp =
  | { kind: "same"; line: string }
  | { kind: "remove"; line: string }
  | { kind: "add"; line: string };

function splitLines(input: string): string[] {
  if (input.length === 0) {
    return [];
  }

  return input.replace(/\r\n/g, "\n").split("\n");
}

function buildDiffOps(aLines: string[], bLines: string[]): DiffOp[] {
  const rows = aLines.length + 1;
  const columns = bLines.length + 1;
  const lcs = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0),
  );

  for (let aIndex = aLines.length - 1; aIndex >= 0; aIndex -= 1) {
    for (let bIndex = bLines.length - 1; bIndex >= 0; bIndex -= 1) {
      lcs[aIndex][bIndex] =
        aLines[aIndex] === bLines[bIndex]
          ? lcs[aIndex + 1][bIndex + 1] + 1
          : Math.max(lcs[aIndex + 1][bIndex], lcs[aIndex][bIndex + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let aIndex = 0;
  let bIndex = 0;

  while (aIndex < aLines.length && bIndex < bLines.length) {
    if (aLines[aIndex] === bLines[bIndex]) {
      ops.push({ kind: "same", line: aLines[aIndex] ?? "" });
      aIndex += 1;
      bIndex += 1;
      continue;
    }

    if (lcs[aIndex + 1]?.[bIndex] >= lcs[aIndex]?.[bIndex + 1]) {
      ops.push({ kind: "remove", line: aLines[aIndex] ?? "" });
      aIndex += 1;
    } else {
      ops.push({ kind: "add", line: bLines[bIndex] ?? "" });
      bIndex += 1;
    }
  }

  while (aIndex < aLines.length) {
    ops.push({ kind: "remove", line: aLines[aIndex] ?? "" });
    aIndex += 1;
  }

  while (bIndex < bLines.length) {
    ops.push({ kind: "add", line: bLines[bIndex] ?? "" });
    bIndex += 1;
  }

  return ops;
}

export function colorizedUnifiedDiff(
  a: string,
  b: string,
  labelA: string,
  labelB: string,
): string {
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const lines = [
    pc.red(`--- ${labelA}`),
    pc.green(`+++ ${labelB}`),
    pc.cyan(`@@ -1,${aLines.length} +1,${bLines.length} @@`),
  ];

  if (a === b) {
    lines.push(pc.dim(" no changes"));
    return lines.join("\n");
  }

  for (const op of buildDiffOps(aLines, bLines)) {
    switch (op.kind) {
      case "same":
        lines.push(` ${op.line}`);
        break;
      case "remove":
        lines.push(pc.red(`-${op.line}`));
        break;
      case "add":
        lines.push(pc.green(`+${op.line}`));
        break;
    }
  }

  return lines.join("\n");
}
