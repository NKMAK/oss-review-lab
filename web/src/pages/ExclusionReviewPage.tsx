import { ExclusionReview } from "../features/exclusion/ExclusionReview";

/** /review/exclusion: 除外の目視確認(中身は features/exclusion/)。 */
export default function ExclusionReviewPage() {
  return (
    <section data-testid="page-exclusion-review">
      <h2 className="mb-3 text-xl font-bold">除外の目視確認(is_ack)</h2>
      <ExclusionReview />
    </section>
  );
}
