export function parseFlags(args: string[]): { positional: string[]; flags: Set<string>; values: Map<string, string> } {
  const positional: string[] = [], flags = new Set<string>(), values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) { const item = args[i]!; if (!item.startsWith("--")) { positional.push(item); continue; } const [key, inline] = item.slice(2).split("=", 2); if (inline !== undefined) values.set(key!, inline); else if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) { values.set(key!, args[++i]!); } else flags.add(key!); }
  return { positional, flags, values };
}
