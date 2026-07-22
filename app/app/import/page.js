import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
import ImportPage from "./ui";
export const dynamic = "force-dynamic";

export default async function Page() {
  if (!isOrganizer(await getSessionUser())) redirect("/login");
  return <ImportPage />;
}
