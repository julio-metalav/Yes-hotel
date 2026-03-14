import "dotenv/config";

export function getArgValue(flagName: string): string | undefined {
  const index = process.argv.indexOf(flagName);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

export function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`Valor numerico invalido informado: ${value}`);
  }

  return parsed;
}

export function printJson(title: string, data: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(data, null, 2));
}
