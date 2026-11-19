// ✗ async-can: if (!canShip(order)) tests a Promise, which is never falsy
export async function canShip(sku: string) {
  return sku.length > 0;
}
export const canHold = (sku: string) => sku !== "";
