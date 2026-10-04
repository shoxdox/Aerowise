import { redirect } from "next/navigation";

// The office starts at the exception inbox; technicians are sent on to /tech from there.
export default function Home() {
  redirect("/inbox");
}
