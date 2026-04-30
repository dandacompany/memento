import pc from "picocolors";

interface BannerOptions {
  caption?: string;
  color?: boolean;
  version?: string;
}

const logo = String.raw`
 __  __ ___ __  __ ___ _  _ _____ ___
|  \/  | __|  \/  | __| \| |_   _/ _ \
| |\/| | _|| |\/| | _|| . | | || (_) |
|_|  |_|___|_|  |_|___|_|\_| |_| \___/
`;

export function shouldUseAnsiColor(): boolean {
  if (process.env.NO_COLOR || process.env.TERM === "dumb") {
    return false;
  }

  return Boolean(process.env.FORCE_COLOR || process.stdout.isTTY);
}

export function mementoBanner(opts: BannerOptions = {}): string {
  const color = pc.createColors(opts.color ?? shouldUseAnsiColor());
  const caption = opts.caption
    ? color.bold(color.cyan(opts.caption))
    : color.dim("Bi-directional AI memory sync");
  const version = opts.version ? ` ${color.dim(`v${opts.version}`)}` : "";

  return [
    color.bold(color.magenta(logo.trim())),
    `${caption}${version}`,
  ].join("\n");
}

export function commandHeader(caption: string, version?: string): string {
  return `${mementoBanner({ caption, version })}\n`;
}
