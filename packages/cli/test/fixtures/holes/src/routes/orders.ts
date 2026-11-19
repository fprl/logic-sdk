// A route handler: outside every module, so it may import only a module's index
import * as stock from "../stock";
import { reserved } from "../stock/data"; // ✗ stock's internal file

export const handler = () => ({ reserved: reserved.size, reserve: stock.reserve });
