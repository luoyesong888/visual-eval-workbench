import { StudioApp } from "@/components/StudioApp";

export const dynamic = "force-dynamic";

/**
 * The original question-bank workbench, kept at /advanced for the cases the
 * simple page does not cover (42 built-in image questions, 18 video questions,
 * manual 1-5 scoring, session history). The root page is the streamlined flow.
 */
export default function AdvancedPage() {
  return <StudioApp />;
}
