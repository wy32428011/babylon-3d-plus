export function createId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}
