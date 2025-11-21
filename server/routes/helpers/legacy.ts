export const LEGACY_RC_PREFIX = "LEGACY-";
export const ADMIN_RC_ALLOWED_ROLES = ['admin_rc', 'admin', 'super_admin'] as const;
export const LEGACY_CATEGORY_OPTIONS = ['diamond', 'gold', 'silver'] as const;
export const LEGACY_LOCATION_TYPES = ['mc', 'tcp', 'gp'] as const;
export const LEGACY_PROPERTY_OWNERSHIP = ['owned', 'leased'] as const;
export const LEGACY_OWNER_GENDERS = ['male', 'female', 'other'] as const;
export const LEGACY_STATUS_OPTIONS = [
  'draft',
  'legacy_rc_review',
  'submitted',
  'under_scrutiny',
  'forwarded_to_dtdo',
  'dtdo_review',
  'inspection_scheduled',
  'inspection_under_review',
  'verified_for_payment',
  'payment_pending',
  'approved',
  'rejected',
] as const;

export const generateLegacyApplicationNumber = (district?: string | null) => {
  const prefix = (district || "LEG")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3)
    .padEnd(3, "X");
  return `${LEGACY_RC_PREFIX}${prefix}-${Date.now().toString(36).toUpperCase()}`;
};
