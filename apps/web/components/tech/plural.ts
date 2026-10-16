/** "1 change", "2 changes": a count with its word. */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
