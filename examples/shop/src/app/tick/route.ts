import { shop } from "../caller";

// Vercel Schedules calls it every minute (vercel.json): the crons in code, and the jobs left in the table.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const at = request.headers.get("ce-vssscheduledat"); // the scheduled time, without jitter
  await shop.jobs.tick(at ? new Date(at) : undefined);
  await shop.jobs.sweep();

  return new Response(null, { status: 204 });
}
