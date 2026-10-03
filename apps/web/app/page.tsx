import { redirect } from "next/navigation";

// The exception inbox becomes the home screen in a later module.
export default function Home() {
  redirect("/customers");
}
