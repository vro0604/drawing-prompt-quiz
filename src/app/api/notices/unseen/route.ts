import { NextResponse } from "next/server";
import { fetchHasUnseenResults } from "@/features/notice/rpc";

export const dynamic = "force-dynamic";

export async function GET() {
  const hasUnseen = await fetchHasUnseenResults();
  return NextResponse.json(
    { hasUnseen },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        Vary: "Cookie",
      },
    },
  );
}
