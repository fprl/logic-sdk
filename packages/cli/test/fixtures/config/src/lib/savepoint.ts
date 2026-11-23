export const attempt = (db: { transaction(fn: () => Promise<void>): Promise<void> }) => db.transaction(async () => {});
