/** Application time source. Tests replace it to move the sliding window. */
let current: () => Date = () => new Date();

export const clock = {
  now(): Date {
    return current();
  },
  iso(): string {
    return current().toISOString();
  },
};

export function setClock(source: (() => Date) | null) {
  current = source ?? (() => new Date());
}
