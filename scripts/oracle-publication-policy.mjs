// Shared by exact requisition parity and regional coverage. Raw discovery
// candidates excluded by the existing publication contract are not markets
// the public mission-fit feed must reproduce.
const CLEARLY_NON_OPERATIONAL_TITLE = /\b(business analyst|business operations|cost management|cost estimator|cost analyst|cost controls|procurement|purchasing|finance|financial|security operations|cybersecurity|information security|software|application|frontend|backend|full[ -]?stack|database|product|ux|ui|machine learning|data scientist|talent sourcer|talent acquisition|recruiter|recruiting)\b/i;

export function oraclePublicationEligible(job) {
  return !CLEARLY_NON_OPERATIONAL_TITLE.test(String(job?.title ?? '').replace(/\s+/g, ' ').trim());
}
