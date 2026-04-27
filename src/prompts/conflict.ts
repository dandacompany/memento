import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";

import { select } from "@inquirer/prompts";

import { sha256Hex } from "../adapters/shared/io.js";
import type { ConflictGroup, MemoryDoc } from "../core/types.js";
import { colorizedUnifiedDiff } from "./diff.js";

const require = createRequire(import.meta.url);

interface TmpFile {
  name: string;
  removeCallback: () => void;
}

interface TmpModule {
  fileSync: (opts?: {
    mode?: number;
    prefix?: string;
    postfix?: string;
    discardDescriptor?: boolean;
  }) => TmpFile;
}

const tmp = require("tmp") as TmpModule;

type ConflictChoice = "choose-a" | "choose-b" | "diff" | "edit" | "skip";

function providerLabel(doc: MemoryDoc): string {
  return doc.meta.source;
}

function orderedCandidates(group: ConflictGroup): [MemoryDoc, MemoryDoc] {
  const candidates = [...group.candidates].sort(
    (a, b) => b.meta.mtime - a.meta.mtime,
  );
  const first = candidates[0];
  const second = candidates[1];

  if (!first || !second) {
    throw new Error(
      `Conflict group ${group.key} requires at least two candidates.`,
    );
  }

  return [first, second];
}

function manualMergeTemplate(first: MemoryDoc, second: MemoryDoc): string {
  return [
    `[CHOICE A: ${providerLabel(first)}]`,
    first.body,
    `[CHOICE B: ${providerLabel(second)}]`,
    second.body,
    "[MERGED]",
    first.body,
  ].join("\n");
}

function parseMergedBody(content: string): string {
  const marker = "[MERGED]";
  const markerIndex = content.lastIndexOf(marker);

  if (markerIndex < 0) {
    return content;
  }

  return content.slice(markerIndex + marker.length).replace(/^\r?\n/, "");
}

function waitForEditor(editor: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [filePath], {
      shell: true,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `Editor exited with signal ${signal}.`
            : `Editor exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

async function editAndMerge(
  first: MemoryDoc,
  second: MemoryDoc,
  identityBase: MemoryDoc,
): Promise<MemoryDoc> {
  const tmpFile = tmp.fileSync({
    mode: 0o600,
    prefix: "memento-conflict-",
    postfix: ".md",
    discardDescriptor: true,
  });

  try {
    await fs.writeFile(
      tmpFile.name,
      manualMergeTemplate(first, second),
      "utf8",
    );
    await waitForEditor(process.env.EDITOR ?? "vi", tmpFile.name);

    const content = await fs.readFile(tmpFile.name, "utf8");
    const body = parseMergedBody(content);
    const bodyHash = sha256Hex(body);

    return {
      ...identityBase,
      body,
      meta: {
        ...identityBase.meta,
        bodyHash,
        rawHash: bodyHash,
        mtime: Date.now(),
      },
    };
  } finally {
    tmpFile.removeCallback();
  }
}

async function promptChoice(
  group: ConflictGroup,
  first: MemoryDoc,
  second: MemoryDoc,
): Promise<ConflictChoice> {
  return select<ConflictChoice>({
    message: `Which version should win for ${group.key}?`,
    choices: [
      {
        name: `a) ${providerLabel(first)} (latest)`,
        value: "choose-a",
        short: providerLabel(first),
      },
      {
        name: `b) ${providerLabel(second)}`,
        value: "choose-b",
        short: providerLabel(second),
      },
      {
        name: "c) View full diff",
        value: "diff",
        short: "diff",
      },
      {
        name: "d) Edit & merge manually",
        value: "edit",
        short: "edit",
      },
      {
        name: "e) Skip this group",
        value: "skip",
        short: "skip",
      },
    ],
  });
}

export async function conflictPromptUser(
  group: ConflictGroup,
): Promise<MemoryDoc | null> {
  const [first, second] = orderedCandidates(group);
  const identityBase = group.candidates[0] ?? first;

  while (true) {
    const choice = await promptChoice(group, first, second);

    switch (choice) {
      case "choose-a":
        return first;
      case "choose-b":
        return second;
      case "diff":
        console.log(
          colorizedUnifiedDiff(
            first.body,
            second.body,
            providerLabel(first),
            providerLabel(second),
          ),
        );
        break;
      case "edit":
        return editAndMerge(first, second, identityBase);
      case "skip":
        return null;
    }
  }
}
