import { useState, useEffect, useRef, useCallback } from "react";
import { nanoid } from "nanoid";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ArrowRight,
  Save,
  Send,
  Home,
  User as UserIcon,
  Bed,
  Wifi,
  FileText,
  IndianRupee,
  Eye,
  Lightbulb,
  AlertTriangle,
  Sparkles,
  Info,
  MapPin,
  Wind,
  ParkingCircle,
  UtensilsCrossed,
  Droplets,
  Tv,
  Shirt,
  ConciergeBell,
  Trees,
  Mountain,
  PawPrint,
  Video,
  Flame,
  Plus,
  Trash2,
  Copy,
  Accessibility,
  HandHeart,
  Landmark,
  ChefHat,
} from "lucide-react";
import type { User, HomestayApplication, UserProfile, ApplicationServiceContext, ApplicationKind } from "@shared/schema";
import { ObjectUploader, type UploadedFileMetadata } from "@/components/ObjectUploader";
import { ApplicationSummaryCard } from "@/components/application/application-summary";
import { ApplicationKindBadge, getApplicationKindLabel, isServiceApplication } from "@/components/application/application-kind-badge";
import { calculateHomestayFee, formatFee, suggestCategory, validateCategorySelection, CATEGORY_REQUIREMENTS, MAX_ROOMS_ALLOWED, MAX_BEDS_ALLOWED, type CategoryType, type LocationType } from "@shared/fee-calculator";
import type { RoomCalcModeSetting } from "@shared/appSettings";
import { DEFAULT_ROOM_CALC_MODE } from "@shared/appSettings";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApplicationStepper } from "@/components/application-stepper";
import { useLocation } from "wouter";
import {
  DEFAULT_STATE,
  getDistricts,
  getTehsilsForDistrict,
  LOCATION_TYPE_OPTIONS,
} from "@shared/regions";
import {
  DEFAULT_UPLOAD_POLICY,
  type UploadPolicy,
} from "@shared/uploadPolicy";
import { isCorrectionRequiredStatus } from "@/constants/workflow";
import {
  DEFAULT_CATEGORY_ENFORCEMENT,
  DEFAULT_CATEGORY_RATE_BANDS,
  type CategoryEnforcementSetting,
  type CategoryRateBands,
} from "@shared/appSettings";

const HP_STATE = DEFAULT_STATE;
const HP_DISTRICTS = getDistricts();
const canonicalizeInput = (value?: string | null) =>
  typeof value === "string" ? value.trim() : "";

const findCanonicalMatch = (value: string, options: string[]) => {
  if (!value) {
    return "";
  }
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  const lower = normalized.toLowerCase();
  const exact = options.find((option) => option.toLowerCase() === lower);
  if (exact) {
    return exact;
  }
  const sanitized = lower.replace(/district$/i, "").trim();
  const sanitizedMatch = options.find(
    (option) => option.toLowerCase() === sanitized,
  );
  if (sanitizedMatch) {
    return sanitizedMatch;
  }
  const partial = options.find((option) =>
    lower.includes(option.toLowerCase()),
  );
  return partial || normalized;
};

const clampInt = (value: string) => {
  if (!value || value.trim() === "") {
    return 0;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
};

const NON_NEGATIVE_DECIMAL = /^\d*(\.\d*)?$/;

const clampFloat = (value: string) => {
  if (!value) {
    return undefined;
  }
  const sanitized = value.replace(/,/g, "").trim();
  if (!sanitized) {
    return undefined;
  }
  if (!NON_NEGATIVE_DECIMAL.test(sanitized)) {
    return undefined;
  }
  const parsed = parseFloat(sanitized);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
};

const sanitizeGstinInput = (value: string) =>
  value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15);
const GSTIN_REGEX = /^[0-9A-Z]{15}$/;

const PINCODE_PREFIX = "17";
const PINCODE_SUFFIX_LENGTH = 6 - PINCODE_PREFIX.length;
const PINCODE_REGEX = /^[1-9]\d{5}$/;
const sanitizePincodeSuffix = (value: string) =>
  value.replace(/[^\d]/g, "").slice(0, PINCODE_SUFFIX_LENGTH);
const ensurePincodeWithPrefix = (value?: string) => {
  const incoming = value ?? "";
  const suffixSource = incoming.startsWith(PINCODE_PREFIX)
    ? incoming.slice(PINCODE_PREFIX.length)
    : incoming;
  return (PINCODE_PREFIX + sanitizePincodeSuffix(suffixSource)).slice(0, 6);
};

const normalizeOptionalFloat = (value: string) => clampFloat(value);

const LOCATION_TYPES = LOCATION_TYPE_OPTIONS;
const LOCATION_LABEL_MAP = LOCATION_TYPE_OPTIONS.reduce(
  (acc, option) => ({ ...acc, [option.value]: option.label }),
  {} as Record<string, string>,
);

const PROJECT_TYPE_OPTIONS = [
  { value: "new_project", label: "New Homestay Registration" },
] as const;

const formatDateDisplay = (value?: string | Date | null) => {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const formatDistanceDisplay = (value?: number | null) => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return `${value} km`;
  }
  return "Enter distance in KM";
};

const normalizePositiveNumber = (value: unknown) => {
  const num = coerceNumber(value);
  if (typeof num === "number" && Number.isFinite(num) && num > 0) {
    return num;
  }
  return undefined;
};

const GENDER_OPTIONS = [
  { value: "female", label: "Female (5% additional discount)" },
  { value: "male", label: "Male" },
];

const normalizeGender = (value: unknown): "male" | "female" => {
  return value === "female" ? "female" : "male";
};

// District-based typical distances (user can override)
const DISTRICT_DISTANCES: Record<string, { airport: number; railway: number; cityCenter: number; shopping: number; busStand: number }> = {};

// Strict schema for final submission - all required fields
const OWNERSHIP_LABELS: Record<"owned" | "leased", string> = {
  owned: "Owned",
  leased: "Lease Deed",
};

const CATEGORY_CARD_INFO: Array<{ value: CategoryType; title: string; description: string }> = [
  { value: "silver", title: "Silver", description: "Neighborhood-scale, budget stays" },
  { value: "gold", title: "Gold", description: "Premium comforts & curated experiences" },
  { value: "diamond", title: "Diamond", description: "Luxury suites with bespoke amenities" },
];

const ROOM_TYPE_OPTIONS = [
  { value: "single", label: "Type 1 (Single)" },
  { value: "double", label: "Type 2 (Double)" },
  { value: "suite", label: "Suite" },
] as const;

type RoomTypeOption = typeof ROOM_TYPE_OPTIONS[number]["value"];

const MAX_BEDS_PER_ROOM = 6;

const ROOM_TYPE_CONFIG: Record<
  RoomTypeOption,
  {
    roomsField: keyof ApplicationForm;
    bedsField: keyof ApplicationForm;
    rateField: keyof ApplicationForm;
    sizeField: keyof ApplicationForm;
    defaultBeds: number;
  }
> = {
  single: {
    roomsField: "singleBedRooms",
    bedsField: "singleBedBeds",
    rateField: "singleBedRoomRate",
    sizeField: "singleBedRoomSize",
    defaultBeds: 1,
  },
  double: {
    roomsField: "doubleBedRooms",
    bedsField: "doubleBedBeds",
    rateField: "doubleBedRoomRate",
    sizeField: "doubleBedRoomSize",
    defaultBeds: 2,
  },
  suite: {
    roomsField: "familySuites",
    bedsField: "familySuiteBeds",
    rateField: "familySuiteRate",
    sizeField: "familySuiteSize",
    defaultBeds: 4,
  },
};

const TARIFF_BUCKETS = [
  { value: "lt3k", label: "Less than ₹3,000/night", explanation: "Eligible for SILVER category", minRate: 0, maxRate: 2999, minCategory: "silver" as const },
  { value: "3kto10k", label: "₹3,000 – ₹10,000/night", explanation: "Requires GOLD category or higher", minRate: 3000, maxRate: 10000, minCategory: "gold" as const },
  { value: "gt10k", label: "Above ₹10,000/night", explanation: "Requires DIAMOND category", minRate: 10001, maxRate: 50000, minCategory: "diamond" as const },
];

type TariffBucket = typeof TARIFF_BUCKETS[number]["value"];

const CATEGORY_ORDER: Record<"silver" | "gold" | "diamond", number> = {
  silver: 1,
  gold: 2,
  diamond: 3,
};

type Type2Row = {
  id: string;
  roomType: RoomTypeOption;
  quantity: number;
  tariffBucket: TariffBucket;
  bedsPerRoom: number;
  area?: number | "";
  customRate?: number | "";
};

type RoomCalculationMode = "buckets" | "direct";

const makeEmptyType2Row = (roomType: RoomTypeOption): Type2Row => ({
  id: nanoid(6),
  roomType,
  quantity: 1,
  tariffBucket: "lt3k",
  bedsPerRoom: ROOM_TYPE_CONFIG[roomType].defaultBeds,
  area: "",
});

const getUnusedRoomType = (currentRows: Type2Row[]): RoomTypeOption => {
  const used = new Set(currentRows.map((row) => row.roomType));
  const available = ROOM_TYPE_OPTIONS.find((option) => !used.has(option.value));
  return available ? (available.value as RoomTypeOption) : "single";
};

const getRowBedsPerRoom = (row: Type2Row) => {
  if (typeof row.bedsPerRoom === "number" && row.bedsPerRoom > 0) {
    return row.bedsPerRoom;
  }
  return ROOM_TYPE_CONFIG[row.roomType].defaultBeds;
};

const summarizeRows = (rows: Type2Row[], excludeId?: string) =>
  rows.reduce(
    (acc, row) => {
      if (excludeId && row.id === excludeId) {
        return acc;
      }
      const rooms = Math.max(0, row.quantity);
      const beds = rooms * getRowBedsPerRoom(row);
      return {
        rooms: acc.rooms + rooms,
        beds: acc.beds + beds,
      };
    },
    { rooms: 0, beds: 0 },
  );

const enforceRoomAndBedLimits = (rows: Type2Row[]): Type2Row[] =>
  rows.map((row) => {
    const { rooms: roomsUsedElsewhere, beds: bedsUsedElsewhere } = summarizeRows(rows, row.id);
    let roomsAvailable = Math.max(0, MAX_ROOMS_ALLOWED - roomsUsedElsewhere);
    let bedsAvailable = Math.max(0, MAX_BEDS_ALLOWED - bedsUsedElsewhere);

    let quantity = Math.max(0, Math.min(row.quantity, roomsAvailable));
    if (quantity > bedsAvailable) {
      quantity = bedsAvailable;
    }

    let bedsPerRoom = getRowBedsPerRoom(row);
    if (quantity <= 0 || bedsAvailable <= 0) {
      quantity = quantity <= 0 ? 0 : quantity;
      bedsPerRoom = Math.min(bedsPerRoom, MAX_BEDS_PER_ROOM);
    } else {
      const maxBedsPerRoom = Math.max(1, Math.min(MAX_BEDS_PER_ROOM, Math.floor(bedsAvailable / quantity)));
      bedsPerRoom = Math.max(1, Math.min(bedsPerRoom, maxBedsPerRoom));
    }

    return {
      ...row,
      quantity,
      bedsPerRoom,
    };
  });

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[index]}`;
};

const applicationSchema = z.object({
  // Basic property info
  propertyName: z.string().min(3, "Property name must be at least 3 characters"),
  locationType: z.enum(["mc", "tcp", "gp"]),
  
  // LGD Hierarchical Address
  district: z.string().min(1, "District is required"),
  tehsil: z.string().optional(),
  tehsilOther: z.string().optional().or(z.literal("")),
  gramPanchayat: z.string().optional(),
  gramPanchayatOther: z.string().optional().or(z.literal("")),
  urbanBody: z.string().optional(),
  urbanBodyOther: z.string().optional().or(z.literal("")),
  ward: z.string().optional(),
  address: z.string().min(10, "House/Building number and street required"),
  pincode: z.string().regex(/^[1-9]\d{5}$/, "Enter valid 6-digit pincode"),
  
  // Contact details
  telephone: z.string().optional().or(z.literal("")),
  ownerEmail: z.string().min(1, "Email is required").email("Enter valid email"),
  ownerMobile: z.string().regex(/^[6-9]\d{9}$/, "Enter valid 10-digit mobile"),
  
  // Owner info
  ownerName: z.string().min(3, "Owner name is required"),
  ownerFirstName: z.string().min(1, "First name is required").regex(/^[A-Za-z\s'-]+$/, "First name can only contain letters"),
  ownerLastName: z.string().min(1, "Last name is required").regex(/^[A-Za-z\s'-]+$/, "Last name can only contain letters"),
  ownerGender: z.enum(["male", "female", "other"]),
  ownerAadhaar: z.string().min(1, "Aadhaar is required").regex(/^\d{12}$/, "Aadhaar must be 12 digits"),
  propertyOwnership: z.enum(["owned", "leased"]),
  
  // Category & room rate
  category: z.enum(["diamond", "gold", "silver"]),
  proposedRoomRate: z.number().optional(), // Legacy field for backward compatibility
  
  // Per-room-type rates (2025 Rules - Form-A Certificate Requirement)
  singleBedRoomRate: z.number().min(0).optional(),
  doubleBedRoomRate: z.number().min(0).optional(),
  familySuiteRate: z.number().min(0).optional(),
  
  // Distance from key locations (in km)
  distanceAirport: z.number().min(0).optional(),
  distanceRailway: z.number().min(0).optional(),
  distanceCityCenter: z.number().min(0).optional(),
  distanceShopping: z.number().min(0).optional(),
  distanceBusStand: z.number().min(0).optional(),
  
  // Project type
  projectType: z.enum(["new_rooms", "new_project"]),
  
  // Property details
  propertyArea: z
    .number()
    .min(0, "Property area cannot be negative"),
  
  // Room configuration (single/double/suite)
  singleBedRooms: z.number().int().min(0).default(0),
  singleBedBeds: z.number().int().min(0).default(1),
  singleBedRoomSize: z.number().min(0).optional(),
  doubleBedRooms: z.number().int().min(0).default(0),
  doubleBedBeds: z.number().int().min(0).default(2),
  doubleBedRoomSize: z.number().min(0).optional(),
  familySuites: z.number().int().min(0).max(3, "Maximum 3 family suites").default(0),
  familySuiteBeds: z.number().int().min(0).default(4),
  familySuiteSize: z.number().min(0).optional(),
  attachedWashrooms: z.number().int().min(0),
  
  // Public areas (lobby/dining in sq ft, parking is description)
  lobbyArea: z.number().min(0).optional(),
  diningArea: z.number().min(0).optional(),
  parkingArea: z.string().optional().or(z.literal("")),
  
  // Additional facilities
  ecoFriendlyFacilities: z.string().optional().or(z.literal("")),
  differentlyAbledFacilities: z.string().optional().or(z.literal("")),
  fireEquipmentDetails: z.string().optional().or(z.literal("")),
  
  // GSTIN (mandatory for Diamond/Gold)
  gstin: z.string().optional().or(z.literal("")),
  
  // 2025 Rules - Certificate Validity
  certificateValidityYears: z.enum(["1", "3"]).default("1"),
  
  // Nearest hospital
  nearestHospital: z.string().optional().or(z.literal("")),
});

// Fully relaxed schema for draft saves - all fields optional with no constraints
const draftSchema = z.object({
  propertyName: z.string().optional(),
  locationType: z.enum(["mc", "tcp", "gp"]).optional(),
  district: z.string().optional(),
  tehsil: z.string().optional(),
  tehsilOther: z.string().optional(),
  gramPanchayat: z.string().optional(),
  gramPanchayatOther: z.string().optional(),
  urbanBody: z.string().optional(),
  urbanBodyOther: z.string().optional(),
  ward: z.string().optional(),
  address: z.string().optional(),
  pincode: z.string().optional(),
  telephone: z.string().optional(),
  ownerEmail: z.string().optional(),
  ownerMobile: z.string().optional(),
  ownerName: z.string().optional(),
  ownerFirstName: z.string().optional(),
  ownerLastName: z.string().optional(),
  ownerGender: z.enum(["male", "female", "other"]).optional(),
  ownerAadhaar: z.string().optional(),
  propertyOwnership: z.enum(["owned", "leased"]).optional(),
  category: z.enum(["diamond", "gold", "silver"]).optional(),
  proposedRoomRate: z.number().optional(),
  singleBedRoomRate: z.number().optional(),
  doubleBedRoomRate: z.number().optional(),
  familySuiteRate: z.number().optional(),
  distanceAirport: z.number().optional(),
  distanceRailway: z.number().optional(),
  distanceCityCenter: z.number().optional(),
  distanceShopping: z.number().optional(),
  distanceBusStand: z.number().optional(),
  projectType: z.enum(["new_rooms", "new_project"]).optional(),
  propertyArea: z.number().optional(),
  singleBedRooms: z.number().optional(),
  singleBedBeds: z.number().optional(),
  singleBedRoomSize: z.number().optional(),
  doubleBedRooms: z.number().optional(),
  doubleBedBeds: z.number().optional(),
  doubleBedRoomSize: z.number().optional(),
  familySuites: z.number().optional(),
  familySuiteBeds: z.number().optional(),
  familySuiteSize: z.number().optional(),
  attachedWashrooms: z.number().optional(),
  lobbyArea: z.number().optional(),
  diningArea: z.number().optional(),
  parkingArea: z.string().optional(),
  ecoFriendlyFacilities: z.string().optional(),
  differentlyAbledFacilities: z.string().optional(),
  fireEquipmentDetails: z.string().optional(),
  gstin: z.string().optional(),
  certificateValidityYears: z.enum(["1", "3"]).optional(),
  nearestHospital: z.string().optional(),
});

type ApplicationForm = z.infer<typeof applicationSchema>;
type DraftForm = z.infer<typeof draftSchema>;

const splitFullName = (fullName?: string | null) => {
  if (!fullName) {
    return { firstName: "", lastName: "" };
  }
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }
  const [firstName, ...rest] = parts;
  return { firstName, lastName: rest.join(" ") };
};

const sanitizeNamePart = (value: string) =>
  value.replace(/[^A-Za-z\s'-]/g, "").replace(/\s{2,}/g, " ");

const sanitizeDigits = (value: string, maxLength?: number) => {
  let digitsOnly = value.replace(/\D/g, "");
  if (typeof maxLength === "number") {
    digitsOnly = digitsOnly.slice(0, maxLength);
  }
  return digitsOnly;
};

const bucketToRate = (bucket: TariffBucket) => {
  const info = TARIFF_BUCKETS.find((b) => b.value === bucket);
  if (!info) return 0;
  if (info.value === "gt10k") {
    return info.minRate;
  }
  return info.maxRate;
};

const rateToBucket = (rate?: number | null): TariffBucket | null => {
  if (typeof rate !== "number" || Number.isNaN(rate)) return null;
  if (rate <= 0) return null;
  if (rate <= 3000) return "lt3k";
  if (rate <= 10000) return "3kto10k";
  return "gt10k";
};

const formatShortCurrency = (value: number) => `₹${value.toLocaleString("en-IN")}`;

const formatBandLabel = (band: { min: number; max: number | null }) => {
  if (band.max === null) {
    const previousThreshold = Math.max(0, band.min - 1);
    return `Above ${formatShortCurrency(previousThreshold)} / night`;
  }
  if (band.min <= 1) {
    const nextWhole = Math.max(band.max + 1, 1);
    return `Less than ${formatShortCurrency(nextWhole)} / night`;
  }
  return `${formatShortCurrency(band.min)} – ${formatShortCurrency(band.max)} / night`;
};

type BandStatus = "empty" | "ok" | "below" | "above";

const evaluateBandStatus = (rate: number, band: { min: number; max: number | null }): BandStatus => {
  if (rate <= 0 || Number.isNaN(rate)) {
    return "empty";
  }
  if (rate < band.min) {
    return "below";
  }
  if (band.max !== null && rate > band.max) {
    return "above";
  }
  return "ok";
};

const coerceNumber = (value: unknown, fallback: number | undefined = undefined) => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
};

const normalizeOptionalString = (value?: string | null) => {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const generateClientId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return nanoid();
};

const AMENITIES = [
  { id: "ac", label: "Air Conditioning", icon: Wind },
  { id: "wifi", label: "WiFi", icon: Wifi },
  { id: "parking", label: "Parking", icon: ParkingCircle },
  { id: "restaurant", label: "Restaurant", icon: UtensilsCrossed },
  { id: "hotWater", label: "Hot Water 24/7", icon: Droplets },
  { id: "tv", label: "Television", icon: Tv },
  { id: "laundry", label: "Laundry Service", icon: Shirt },
  { id: "roomService", label: "Room Service", icon: ConciergeBell },
  { id: "garden", label: "Garden", icon: Trees },
  { id: "mountainView", label: "Mountain View", icon: Mountain },
  { id: "petFriendly", label: "Pet Friendly", icon: PawPrint },
  { id: "accessible", label: "Accessible", icon: Accessibility },
  { id: "seniorFriendly", label: "Senior Citizen Friendly", icon: HandHeart },
  { id: "vernacularArchitecture", label: "Vernacular Architecture", icon: Landmark },
  { id: "authenticFood", label: "Authentic Food", icon: ChefHat },
  { id: "cctv", label: "CCTV Surveillance", icon: Video },
  { id: "fireSafety", label: "Fire Safety Equipment", icon: Flame },
];

const MANDATORY_AMENITY_IDS = new Set(["cctv", "fireSafety"]);

// Fee structure as per ANNEXURE-I (location-based)
const FEE_STRUCTURE = {
  diamond: { mc: 18000, tcp: 12000, gp: 10000 },
  gold: { mc: 12000, tcp: 8000, gp: 6000 },
  silver: { mc: 8000, tcp: 5000, gp: 3000 },
};

// Room rate thresholds for categories (as per official document)
const ROOM_RATE_THRESHOLDS = {
  diamond: { min: 10001, label: "Above ₹10,000 per room per day" },
  gold: { min: 3000, max: 10000, label: "₹3,000 – ₹10,000 per room per day" },
  silver: { max: 3000, label: "Less than ₹3,000 per room per day" },
};

// Step configuration for progress tracking
const STEP_CONFIG = [
  {
    id: 1,
    label: "Property Details",
    shortLabel: "Property",
    icon: Home,
    requiredFields: ["propertyName", "projectType", "address", "district", "tehsil", "pincode", "locationType"],
  },
  {
    id: 2,
    label: "Owner Information",
    shortLabel: "Owner Info",
    icon: UserIcon,
    requiredFields: [
      "ownerFirstName",
      "ownerLastName",
      "ownerName",
      "ownerMobile",
      "ownerEmail",
      "ownerAadhaar",
      "ownerGender",
      "propertyOwnership",
    ],
  },
  {
    id: 3,
    label: "Rooms & Category",
    shortLabel: "Rooms",
    icon: Bed,
    requiredFields: ["category", "proposedRoomRate", "attachedWashrooms"],
  },
  {
    id: 4,
    label: "Distances & Areas",
    shortLabel: "Distances",
    icon: MapPin,
    requiredFields: ["distanceAirport", "distanceRailway", "distanceCityCenter", "distanceShopping", "distanceBusStand"],
  },
  {
    id: 5,
    label: "Documents Upload",
    shortLabel: "Documents",
    icon: FileText,
    requiredFields: ["revenuePapers", "affidavitSection29", "undertakingFormC", "propertyPhotos"],
  },
  {
    id: 6,
    label: "Amenities & Review",
    shortLabel: "Review",
    icon: Eye,
    requiredFields: [], // Final review page
  },
];

export default function NewApplication() {
  const [, setLocation] = useLocation();
  const goToProfile = () => setLocation("/profile");
  const renderProfileManagedDescription = (fieldLabel?: string) => (
    <FormDescription>
      {fieldLabel ? `${fieldLabel} ` : "This information "}
      is managed from{" "}
      <Button
        type="button"
        variant="link"
        className="h-auto px-0 text-primary"
        onClick={goToProfile}
      >
        My Profile
      </Button>
      .
    </FormDescription>
  );
  const { toast } = useToast();
const { data: uploadPolicyData } = useQuery<UploadPolicy>({
  queryKey: ["/api/settings/upload-policy"],
  staleTime: 5 * 60 * 1000,
});
const uploadPolicy = uploadPolicyData ?? DEFAULT_UPLOAD_POLICY;

const { data: categoryEnforcementSetting } = useQuery<CategoryEnforcementSetting>({
  queryKey: ["/api/settings/category-enforcement"],
  staleTime: 5 * 60 * 1000,
});
const { data: roomCalcModeSettingData } = useQuery<RoomCalcModeSetting>({
  queryKey: ["/api/settings/room-calc-mode"],
  staleTime: 5 * 60 * 1000,
});
const { data: roomRateBandsData } = useQuery<CategoryRateBands>({
  queryKey: ["/api/settings/room-rate-bands"],
  staleTime: 5 * 60 * 1000,
});
const { data: activeExistingOwner } = useQuery<{ application: { id: string } | null }>({
  queryKey: ["/api/existing-owners/active"],
  staleTime: 30 * 1000,
});
const isCategoryEnforced =
  categoryEnforcementSetting?.enforce ?? DEFAULT_CATEGORY_ENFORCEMENT.enforce;
const lockToRecommendedCategory =
  categoryEnforcementSetting?.lockToRecommended ??
  DEFAULT_CATEGORY_ENFORCEMENT.lockToRecommended;
const categoryRateBands = roomRateBandsData ?? DEFAULT_CATEGORY_RATE_BANDS;
const maxTotalUploadBytes = uploadPolicy.totalPerApplicationMB * 1024 * 1024;
const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1); // Track highest step visited
const [selectedAmenities, setSelectedAmenities] = useState<Record<string, boolean>>({
  cctv: false,
  fireSafety: false,
});
  const [uploadedDocuments, setUploadedDocuments] = useState<Record<string, UploadedFileMetadata[]>>({
    revenuePapers: [],
    affidavitSection29: [],
    undertakingFormC: [],
    commercialElectricityBill: [],
    commercialWaterBill: [],
  });
const [propertyPhotos, setPropertyPhotos] = useState<UploadedFileMetadata[]>([]);
const totalSteps = 6;
const guardrailToastShownRef = useRef(false);

  useEffect(() => {
    if (activeExistingOwner?.application) {
      setLocation(`/applications/${activeExistingOwner.application.id}`);
    }
  }, [activeExistingOwner, setLocation]);

// Get draft ID and correction ID from URL query parameters
const searchParams = new URLSearchParams(window.location.search);
const draftIdFromUrl = searchParams.get('draft');
const correctionIdFromUrl = searchParams.get('application');
const [draftId, setDraftId] = useState<string | null>(draftIdFromUrl);
const [correctionId, setCorrectionId] = useState<string | null>(correctionIdFromUrl);
const [showPreview, setShowPreview] = useState(false);
const [correctionAcknowledged, setCorrectionAcknowledged] = useState(false);
const [type2Rows, setType2RowsBase] = useState<Type2Row[]>(() =>
  enforceRoomAndBedLimits([makeEmptyType2Row("single")]),
);
const setType2RowsSafe = useCallback(
  (updater: (rows: Type2Row[]) => Type2Row[]) => setType2RowsBase((rows) => enforceRoomAndBedLimits(updater(rows))),
  [],
);
const [syncAttachedBaths, setSyncAttachedBaths] = useState(true);
const derivedRoomCalcMode = roomCalcModeSettingData?.mode ?? DEFAULT_ROOM_CALC_MODE.mode;
const [roomCalcMode, setRoomCalcMode] = useState<RoomCalculationMode>(derivedRoomCalcMode);
useEffect(() => {
  setRoomCalcMode(derivedRoomCalcMode);
}, [derivedRoomCalcMode]);
useEffect(() => {
  setType2RowsSafe((rows) =>
    rows.map((row) => {
      if (roomCalcMode === "direct") {
        const resolvedRate = coerceNumber(row.customRate, undefined);
        return {
          ...row,
          customRate: resolvedRate && resolvedRate > 0 ? resolvedRate : "",
        };
      }
      const candidate = coerceNumber(row.customRate, 0);
      return {
        ...row,
        tariffBucket: rateToBucket(candidate) ?? row.tariffBucket,
      };
    }),
  );
}, [roomCalcMode, setType2RowsSafe]);

const [, navigate] = useLocation();
const isCorrectionMode = Boolean(correctionId);
useEffect(() => {
  if (!isCorrectionMode) {
    setCorrectionAcknowledged(false);
  }
}, [isCorrectionMode]);

const { data: userData } = useQuery<{ user: User }>({
  queryKey: ["/api/auth/me"],
});

const defaultOwnerNameParts = splitFullName(userData?.user?.fullName || "");

const form = useForm<ApplicationForm>({
  // No resolver - validation happens manually on next/submit to allow draft saves
  defaultValues: {
    propertyName: "",
    address: "",
    district: "",
    pincode: PINCODE_PREFIX,
    locationType: "" as LocationType | "",
    telephone: "",
    tehsil: "",
    tehsilOther: "",
    gramPanchayat: "",
    urbanBody: "",
    ward: "",
    ownerEmail: userData?.user?.email || "",
    ownerMobile: userData?.user?.mobile || "",
    ownerName: userData?.user?.fullName || "",
    ownerFirstName: defaultOwnerNameParts.firstName,
    ownerLastName: defaultOwnerNameParts.lastName,
    ownerAadhaar: userData?.user?.aadhaarNumber || "",
    ownerGender: normalizeGender((userData?.user as any)?.gender) as "male" | "female" | "other",
    propertyOwnership: "owned",
    category: "silver",
    proposedRoomRate: 2000,
    singleBedRoomRate: 0,
    doubleBedRoomRate: 0,
    familySuiteRate: 0,
    projectType: "new_project",
    propertyArea: 0,
    singleBedRooms: 0,
    singleBedBeds: 1,
    singleBedRoomSize: undefined,
    doubleBedRooms: 0,
    doubleBedBeds: 2,
    doubleBedRoomSize: undefined,
    familySuites: 0,
    familySuiteBeds: 4,
    familySuiteSize: undefined,
    attachedWashrooms: 1,
    gstin: "",
    distanceAirport: undefined,
    distanceRailway: undefined,
    distanceCityCenter: undefined,
    distanceShopping: undefined,
    distanceBusStand: undefined,
    lobbyArea: undefined,
    diningArea: undefined,
    parkingArea: "",
    ecoFriendlyFacilities: "",
    differentlyAbledFacilities: "",
    fireEquipmentDetails: "",
    certificateValidityYears: "1",
    nearestHospital: "",
  },
});

const { data: applicationsData } = useQuery<{ applications: HomestayApplication[] }>({
  queryKey: ["/api/applications"],
  enabled: !!userData?.user,
  staleTime: 30_000,
});

useEffect(() => {
  if (isCorrectionMode) {
    return;
  }
  if (!applicationsData?.applications) return;
  const apps = applicationsData.applications;
  if (apps.length === 0) {
    return;
  }

  const draftApplication = apps.find((app) => app.status === "draft");
  if (draftApplication) {
    if (!draftId || draftId !== draftApplication.id) {
      const url = new URL(window.location.href);
      url.searchParams.set("draft", draftApplication.id);
      window.history.replaceState(null, "", url.pathname + url.search);
      setDraftId(draftApplication.id);
    }
    return;
  }

  const activeApplication = apps[0];
  if (!guardrailToastShownRef.current) {
    guardrailToastShownRef.current = true;
    toast({
      title: "Application already in progress",
      description: "You already have an application in process. You’ll be redirected to continue it.",
    });
  }
  setLocation(`/applications/${activeApplication.id}`);
  }, [applicationsData, draftId, setLocation, toast, isCorrectionMode]);

  // Fetch user profile for auto-population
  const { data: userProfile } = useQuery<UserProfile | null>({
    queryKey: ["/api/profile"],
    enabled: !!userData?.user,
    retry: false,
    queryFn: async ({ queryKey }) => {
      const res = await fetch(queryKey[0] as string, {
        credentials: "include",
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(text);
      }
      return res.json();
    },
  });

  // Load draft application if resuming
const [draftApplication, setDraftApplication] = useState<HomestayApplication | null>(null);
const [isDraftLoading, setIsDraftLoading] = useState(false);
const draftIdToLoad = draftId ?? draftIdFromUrl ?? null;

useEffect(() => {
  let cancelled = false;
  if (!draftIdToLoad) {
    setDraftApplication(null);
    return;
  }
  setIsDraftLoading(true);
  (async () => {
    try {
      const res = await fetch(`/api/applications/${draftIdToLoad}`, {
        credentials: "include",
      });
      if (res.status === 401) {
        if (!cancelled) {
          setDraftApplication(null);
        }
        return;
      }
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(text);
      }
      const data = await res.json();
      if (!cancelled) {
        setDraftApplication(data?.application ?? null);
      }
    } catch (error) {
      console.error("[draft-load]", error);
      if (!cancelled) {
        setDraftApplication(null);
      }
    } finally {
      if (!cancelled) {
        setIsDraftLoading(false);
      }
    }
  })();
  return () => {
    cancelled = true;
  };
}, [draftIdToLoad]);

const { data: correctionData } = useQuery<{ application: HomestayApplication }>({
  queryKey: ["/api/applications", correctionIdFromUrl],
  enabled: !!correctionIdFromUrl,
});

const activeDraftApplication = draftApplication;
const activeCorrectionApplication = correctionData?.application ?? null;
const activeHydratedApplication = activeDraftApplication ?? (isCorrectionMode ? activeCorrectionApplication : null);
const activeApplicationKind = (activeHydratedApplication?.applicationKind as ApplicationKind | undefined) ?? "new_registration";
  const isServiceDraft = Boolean(activeDraftApplication && isServiceApplication(activeApplicationKind));
  const serviceContext = (activeDraftApplication?.serviceContext ?? null) as ApplicationServiceContext | null;
  const parentApplicationNumber = activeDraftApplication?.parentApplicationNumber ?? null;
  const parentApplicationId = activeDraftApplication?.parentApplicationId ?? null;
  const parentCertificateNumber = activeDraftApplication?.parentCertificateNumber ?? activeDraftApplication?.certificateNumber ?? null;
const inheritedCertificateExpiry = activeDraftApplication?.inheritedCertificateValidUpto ?? activeDraftApplication?.certificateExpiryDate ?? null;
const requestedRooms = serviceContext?.requestedRooms;
const requestedRoomDelta = serviceContext?.requestedRoomDelta;
const serviceNote = activeDraftApplication?.serviceNotes;
  const shouldLockPropertyDetails = isServiceDraft;

  useEffect(() => {
    if (!activeDraftApplication) {
      return;
    }
    const currentTehsilValue = form.getValues("tehsil");
    const currentDistrictValue = form.getValues("district");
    if (!currentDistrictValue && activeDraftApplication.district) {
      form.setValue("district", activeDraftApplication.district, {
        shouldDirty: false,
        shouldValidate: false,
      });
    }
    if (!currentTehsilValue && (activeDraftApplication.tehsil || activeDraftApplication.tehsilOther)) {
      form.setValue("tehsil", activeDraftApplication.tehsil || "__other", {
        shouldDirty: false,
        shouldValidate: false,
      });
      form.setValue("tehsilOther", activeDraftApplication.tehsilOther || "", {
        shouldDirty: false,
        shouldValidate: false,
      });
    }
  }, [activeDraftApplication, form]);


const buildType2RowsFromForm = useCallback((): Type2Row[] => {
  const rows: Type2Row[] = [];
  ROOM_TYPE_OPTIONS.forEach((option) => {
    const config = ROOM_TYPE_CONFIG[option.value];
    const qty = Number(form.getValues(config.roomsField)) || 0;
    const rate = Number(form.getValues(config.rateField)) || 0;
    const directRate = rate > 0 ? rate : "";
    const bedsPerRoomValue =
      coerceNumber(form.getValues(config.bedsField), config.defaultBeds) ?? config.defaultBeds;
    const normalizedBeds = Math.max(1, Math.min(bedsPerRoomValue, MAX_BEDS_PER_ROOM));
    const areaValue = form.getValues(config.sizeField);
    const areaNumber =
      typeof areaValue === "number"
        ? areaValue
        : typeof areaValue === "string" && areaValue.trim()
        ? Number(areaValue)
        : "";
    if (qty > 0 || rate > 0 || (typeof areaNumber === "number" && areaNumber > 0)) {
      rows.push({
        id: nanoid(6),
        roomType: option.value as RoomTypeOption,
        quantity: qty,
        tariffBucket: rateToBucket(rate) ?? "lt3k",
        bedsPerRoom: normalizedBeds,
        area: areaNumber,
        customRate: directRate,
      });
    }
  });
  if (rows.length === 0) {
    rows.push(makeEmptyType2Row("single"));
  }
  return rows;
}, [form]);

const applyType2RowsToForm = useCallback(
  (rows: Type2Row[]) => {
    form.setValue("singleBedRooms", 0);
    form.setValue("singleBedRoomRate", 0);
    form.setValue("singleBedRoomSize", undefined);
    form.setValue("singleBedBeds", ROOM_TYPE_CONFIG.single.defaultBeds);
    form.setValue("doubleBedRooms", 0);
    form.setValue("doubleBedRoomRate", 0);
    form.setValue("doubleBedRoomSize", undefined);
    form.setValue("doubleBedBeds", ROOM_TYPE_CONFIG.double.defaultBeds);
    form.setValue("familySuites", 0);
    form.setValue("familySuiteRate", 0);
    form.setValue("familySuiteSize", undefined);
    form.setValue("familySuiteBeds", ROOM_TYPE_CONFIG.suite.defaultBeds);

    rows.forEach((row) => {
      const config = ROOM_TYPE_CONFIG[row.roomType];
      form.setValue(config.roomsField, row.quantity);
      form.setValue(config.bedsField, getRowBedsPerRoom(row));
      const directRate = coerceNumber(row.customRate, undefined);
      const resolvedRate =
        roomCalcMode === "direct"
          ? directRate && directRate > 0
            ? directRate
            : undefined
          : bucketToRate(row.tariffBucket);
      form.setValue(config.rateField, resolvedRate);
      const areaValue =
        typeof row.area === "number"
          ? row.area
          : typeof row.area === "string" && row.area.trim()
          ? Number(row.area)
          : undefined;
      form.setValue(config.sizeField, areaValue);
    });
  },
  [form, roomCalcMode],
);

useEffect(() => {
  setType2RowsSafe(() => buildType2RowsFromForm());
}, [buildType2RowsFromForm, setType2RowsSafe]);

useEffect(() => {
  applyType2RowsToForm(type2Rows);
}, [type2Rows, applyType2RowsToForm]);

const updateType2Row = useCallback((rowId: string, updates: Partial<Type2Row>) => {
  setType2RowsSafe((rows) =>
    rows.map((row) =>
      row.id === rowId
        ? {
            ...row,
            ...updates,
            quantity:
              typeof updates.quantity === "number"
                ? Math.max(0, Math.min(updates.quantity, MAX_ROOMS_ALLOWED))
                : row.quantity,
          }
        : row,
    ),
  );
}, [setType2RowsSafe]);

const addType2Row = useCallback(() => {
  setType2RowsSafe((rows) => {
    if (rows.length >= ROOM_TYPE_OPTIONS.length) {
      return rows;
    }
    const newType = getUnusedRoomType(rows);
    return [...rows, makeEmptyType2Row(newType)];
  });
}, [setType2RowsSafe]);

const removeType2Row = useCallback((rowId: string) => {
  setType2RowsSafe((rows) => rows.filter((row) => row.id !== rowId));
}, [setType2RowsSafe]);

const resetType2Rows = useCallback(() => {
  setType2RowsSafe(() => [makeEmptyType2Row("single")]);
  setSyncAttachedBaths(true);
  applyType2RowsToForm([makeEmptyType2Row("single")]);
}, [applyType2RowsToForm, setType2RowsSafe]);

  // Ensure location type starts blank for fresh applications (force manual selection)
  useEffect(() => {
    if (draftIdFromUrl || correctionIdFromUrl || activeDraftApplication) {
      return;
    }
    form.setValue("locationType", "" as LocationType | "", {
      shouldDirty: false,
      shouldValidate: false,
    });
  }, [draftIdFromUrl, correctionIdFromUrl, activeDraftApplication, form]);

const category = form.watch("category");
const isPremiumCategory = category === "gold" || category === "diamond";
const requiresGstin = isPremiumCategory;
const requiresCommercialUtilityProof = isPremiumCategory;
const watchedGstin = form.watch("gstin");
const normalizedWatchedGstin = sanitizeGstinInput(watchedGstin ?? "");
const gstinHasValue = normalizedWatchedGstin.length > 0;
const gstinMatchesPattern = GSTIN_REGEX.test(normalizedWatchedGstin);
const gstinIsValid = !requiresGstin || (gstinHasValue && gstinMatchesPattern);
const gstinBlocking = requiresGstin && !gstinIsValid;
const locationType = (form.watch("locationType") || "") as LocationType | "";
const resolvedLocationType = (locationType || "gp") as LocationType;
  const watchedDistrict = form.watch("district");
  const isHydratingDraft = useRef(false);
  const gramFieldConfig =
    locationType === "gp"
      ? {
          label: "Village / Locality (PO)",
          placeholder: "Type your village, locality, or Post Office",
          description: "Required for Gram Panchayat areas.",
          requiredMessage: "Village / locality is required for Gram Panchayat properties",
        }
      : null;

  const urbanBodyConfig =
    locationType === "mc"
      ? {
          label: "Enter City/Town (MC/Council)",
          placeholder: "e.g., Shimla, Theog",
          description: "Required for Municipal Corporation or Council applicants.",
        }
      : locationType === "tcp"
        ? {
            label: "Enter Town (TCP/SADA/NP)",
            placeholder: "e.g., Suni, Narkanda",
            description: "Required for TCP/SADA/Nagar Panchayat applicants.",
          }
        : {
            label: "Municipal Corporation / TCP / Nagar Panchayat",
            placeholder: "e.g., Shimla MC, Theog NP",
            description: "Type the name of your urban local body.",
          };

  useEffect(() => {
    if (isHydratingDraft.current) {
      return;
    }
    if (!watchedDistrict) {
      form.setValue("tehsil", "", {
        shouldDirty: false,
        shouldValidate: step >= 1,
      });
      form.setValue("tehsilOther", "", {
        shouldDirty: false,
        shouldValidate: step >= 1,
      });
      return;
    }

    const tehsilsForDistrict = getTehsilsForDistrict(watchedDistrict);
    const currentTehsil = form.getValues("tehsil");
    if (currentTehsil === "__other") {
      return;
    }

    if (tehsilsForDistrict.length === 0) {
      if (currentTehsil !== "__other") {
        form.setValue("tehsil", "__other", {
          shouldDirty: false,
          shouldValidate: step >= 1,
        });
      }
      return;
    }

    if (!currentTehsil || !tehsilsForDistrict.includes(currentTehsil)) {
      form.setValue("tehsil", "", {
        shouldDirty: false,
        shouldValidate: step >= 1,
      });
      form.setValue("tehsilOther", "", {
        shouldDirty: false,
        shouldValidate: step >= 1,
      });
    }
  }, [watchedDistrict, form, step]);
  const district = form.watch("district");
const tehsil = form.watch("tehsil");
const tehsilOther = form.watch("tehsilOther");
const pincodeValue = form.watch("pincode");
const ownerFirstName = form.watch("ownerFirstName");
const ownerLastName = form.watch("ownerLastName");
const ownerGender = form.watch("ownerGender");
const propertyOwnership = form.watch("propertyOwnership") as "owned" | "leased" | undefined;
const certificateValidityYears = form.watch("certificateValidityYears");
  const isLeaseBlocked = step === 2 && propertyOwnership === "leased";
const submitButtonLabel = isCorrectionMode ? "Resubmit Application" : "Submit Application";
const stepTopRef = useRef<HTMLDivElement | null>(null);
const trimmedTehsilOther = tehsilOther?.trim() || "";
const displayTehsil = tehsil === "__other" ? (trimmedTehsilOther || "—") : (tehsil || "—");
const tehsilForRules = tehsil === "__other" ? trimmedTehsilOther : tehsil;
const normalizedPincode = ensurePincodeWithPrefix(pincodeValue ?? PINCODE_PREFIX);
const pincodeSuffixValue = normalizedPincode.slice(PINCODE_PREFIX.length);
const pincodeIsValid = PINCODE_REGEX.test(normalizedPincode);
const showPincodeHint = pincodeSuffixValue.length < PINCODE_SUFFIX_LENGTH;

useEffect(() => {
  if (isHydratingDraft.current) {
    return;
  }
  const currentTehsilValue = form.getValues("tehsil") ?? "";
  const currentTehsilOtherValue =
    currentTehsilValue === "__other" ? form.getValues("tehsilOther") ?? "" : "";
  lastHydratedTehsil.current = {
    value: currentTehsilValue,
    other: currentTehsilOtherValue,
  };
}, [form, tehsil, tehsilOther]);

useEffect(() => {
  if (isHydratingDraft.current) {
    return;
  }
    if (!district) {
      if (tehsil || tehsilOther) {
        form.setValue("tehsil", "", { shouldDirty: false, shouldValidate: step >= 1 });
        form.setValue("tehsilOther", "", { shouldDirty: false, shouldValidate: step >= 1 });
      }
      return;
    }

    const tehsilOptions = getTehsilsForDistrict(district);
    const hasOptions = tehsilOptions.length > 0;

    if (tehsil === "__other") {
      if (!hasOptions) {
        return;
      }
      if (tehsilOther && tehsilOther.trim().length > 0) {
        return;
      }
      form.setValue("tehsil", "", { shouldDirty: false, shouldValidate: step >= 1 });
      form.setValue("tehsilOther", "", { shouldDirty: false, shouldValidate: step >= 1 });
      return;
    }

    if (!hasOptions) {
      if (tehsil !== "__other") {
        const manualValue = tehsil?.trim() ?? "";
        form.setValue("tehsil", "__other", { shouldDirty: false, shouldValidate: step >= 1 });
        form.setValue("tehsilOther", manualValue, { shouldDirty: false, shouldValidate: step >= 1 });
      }
      return;
    }

    if (!tehsil) {
      if (tehsilOther) {
        form.setValue("tehsilOther", "", { shouldDirty: false, shouldValidate: step >= 1 });
      }
      return;
    }

    if (!tehsilOptions.includes(tehsil)) {
      form.setValue("tehsil", "", { shouldDirty: false, shouldValidate: step >= 1 });
      form.setValue("tehsilOther", "", { shouldDirty: false, shouldValidate: step >= 1 });
      return;
    }

    if (tehsilOther) {
      form.setValue("tehsilOther", "", { shouldDirty: false, shouldValidate: step >= 1 });
    }
  }, [district, tehsil, tehsilOther, form, step]);

useEffect(() => {
const enforced = ensurePincodeWithPrefix(pincodeValue ?? PINCODE_PREFIX);
  if (enforced !== pincodeValue) {
    form.setValue("pincode", enforced, { shouldDirty: true, shouldValidate: step >= 1 });
  }
}, [pincodeValue, form, step]);

useEffect(() => {
  if (!requiresGstin) {
    form.clearErrors("gstin");
    return;
  }
  if (!gstinHasValue) {
    form.setError("gstin", {
      type: "manual",
      message: "GSTIN is required for Diamond and Gold categories",
    });
    return;
  }
  if (!gstinMatchesPattern) {
    form.setError("gstin", {
      type: "manual",
      message: "GSTIN must be exactly 15 characters (numbers and capital letters only)",
    });
    return;
  }
  form.clearErrors("gstin");
}, [requiresGstin, gstinHasValue, gstinMatchesPattern, form]);

useEffect(() => {
  stepTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
}, [step]);

const lastHydratedTehsil = useRef<{ value: string; other: string }>({ value: "", other: "" });

const hydrateFormFromSource = (source: Partial<HomestayApplication> | DraftForm | null | undefined) => {
    if (!source) return;
    const defaults = form.getValues();
    const explicitFirst = (source as any).ownerFirstName as string | undefined;
    const explicitLast = (source as any).ownerLastName as string | undefined;
    const nameParts = splitFullName(source.ownerName ?? defaults.ownerName);
    const resolvedFirstName = explicitFirst ?? nameParts.firstName ?? defaults.ownerFirstName ?? "";
    const resolvedLastName = explicitLast ?? nameParts.lastName ?? defaults.ownerLastName ?? "";
    const resolvedCertificateYears =
      (source as any).certificateValidityYears !== undefined && (source as any).certificateValidityYears !== null
        ? String((source as any).certificateValidityYears)
        : defaults.certificateValidityYears;

    const rawDistrictValue =
      (source as any).district ?? defaults.district ?? "";
    const districtValue = findCanonicalMatch(
      canonicalizeInput(rawDistrictValue),
      HP_DISTRICTS,
    );
    const incomingTehsilRaw =
      (source as any).tehsil ?? defaults.tehsil ?? "";
    const incomingTehsilOtherRaw =
      (source as any).tehsilOther ?? defaults.tehsilOther ?? "";

    const tehsilOptions = districtValue
      ? getTehsilsForDistrict(districtValue)
      : [];
    const trimmedTehsil = canonicalizeInput(incomingTehsilRaw).replace(
      /^not provided$/i,
      "",
    );
    const trimmedTehsilOther = canonicalizeInput(incomingTehsilOtherRaw);
    const canonicalTehsil =
      tehsilOptions.length > 0
        ? findCanonicalMatch(trimmedTehsil, tehsilOptions)
        : trimmedTehsil;

    let resolvedTehsil: string;
    let resolvedTehsilOther: string;

    if (canonicalTehsil && tehsilOptions.includes(canonicalTehsil)) {
      resolvedTehsil = canonicalTehsil;
      resolvedTehsilOther = "";
    } else if (trimmedTehsil) {
      resolvedTehsil = "__other";
      resolvedTehsilOther = trimmedTehsil;
    } else if (trimmedTehsilOther) {
      resolvedTehsil = "__other";
      resolvedTehsilOther = trimmedTehsilOther;
    } else if (tehsilOptions.length > 0) {
      resolvedTehsil = tehsilOptions[0];
      resolvedTehsilOther = "";
    } else {
      resolvedTehsil = "";
      resolvedTehsilOther = "";
    }

    isHydratingDraft.current = true;
    lastHydratedTehsil.current = { value: resolvedTehsil, other: resolvedTehsilOther };
    form.reset({
      ...defaults,
      propertyName: source.propertyName ?? defaults.propertyName ?? "",
      address: source.address ?? defaults.address ?? "",
      district: districtValue,
      tehsil: resolvedTehsil,
      tehsilOther: resolvedTehsilOther,
      gramPanchayat: (source as any).gramPanchayat ?? defaults.gramPanchayat ?? "",
      urbanBody: (source as any).urbanBody ?? defaults.urbanBody ?? "",
      ward: (source as any).ward ?? defaults.ward ?? "",
      pincode: (source as any).pincode ?? defaults.pincode ?? "",
      locationType: ((source.locationType as "mc" | "tcp" | "gp") ?? "") as LocationType | "",
      telephone: (source as any).telephone ?? defaults.telephone ?? "",
      ownerEmail: source.ownerEmail ?? defaults.ownerEmail ?? "",
      ownerMobile: source.ownerMobile ?? defaults.ownerMobile ?? "",
      ownerName: source.ownerName ?? defaults.ownerName ?? "",
      ownerFirstName: resolvedFirstName,
      ownerLastName: resolvedLastName,
      ownerGender: normalizeGender(
        (source.ownerGender as "male" | "female" | "other") ?? defaults.ownerGender,
      ) as "male" | "female" | "other",
      ownerAadhaar: source.ownerAadhaar ?? defaults.ownerAadhaar ?? "",
      propertyOwnership: ((source as any).propertyOwnership as "owned" | "leased") ?? defaults.propertyOwnership ?? "owned",
      category: (source.category as "diamond" | "gold" | "silver") ?? defaults.category ?? "silver",
      proposedRoomRate: coerceNumber((source as any).proposedRoomRate, defaults.proposedRoomRate ?? 0) ?? 0,
      singleBedRoomRate: coerceNumber((source as any).singleBedRoomRate, defaults.singleBedRoomRate ?? 0) ?? 0,
      doubleBedRoomRate: coerceNumber((source as any).doubleBedRoomRate, defaults.doubleBedRoomRate ?? 0) ?? 0,
      familySuiteRate: coerceNumber((source as any).familySuiteRate, defaults.familySuiteRate ?? 0) ?? 0,
      projectType: (source.projectType as "new_rooms" | "new_project") ?? defaults.projectType ?? "new_project",
      propertyArea: coerceNumber((source as any).propertyArea, defaults.propertyArea ?? 0) ?? 0,
      singleBedRooms: coerceNumber((source as any).singleBedRooms, defaults.singleBedRooms ?? 0) ?? 0,
      singleBedBeds: coerceNumber((source as any).singleBedBeds, defaults.singleBedBeds ?? 1) ?? 1,
      singleBedRoomSize: coerceNumber((source as any).singleBedRoomSize),
      doubleBedRooms: coerceNumber((source as any).doubleBedRooms, defaults.doubleBedRooms ?? 0) ?? 0,
      doubleBedBeds: coerceNumber((source as any).doubleBedBeds, defaults.doubleBedBeds ?? 2) ?? 2,
      doubleBedRoomSize: coerceNumber((source as any).doubleBedRoomSize),
      familySuites: coerceNumber((source as any).familySuites, defaults.familySuites ?? 0) ?? 0,
      familySuiteBeds: coerceNumber((source as any).familySuiteBeds, defaults.familySuiteBeds ?? 4) ?? 4,
      familySuiteSize: coerceNumber((source as any).familySuiteSize),
      attachedWashrooms: coerceNumber((source as any).attachedWashrooms, defaults.attachedWashrooms ?? 0) ?? 0,
      gstin: (source as any).gstin ?? defaults.gstin ?? "",
      distanceAirport: normalizePositiveNumber((source as any).distanceAirport),
      distanceRailway: normalizePositiveNumber((source as any).distanceRailway),
      distanceCityCenter: normalizePositiveNumber((source as any).distanceCityCenter),
      distanceShopping: normalizePositiveNumber((source as any).distanceShopping),
      distanceBusStand: normalizePositiveNumber((source as any).distanceBusStand),
      lobbyArea: normalizePositiveNumber((source as any).lobbyArea),
      diningArea: normalizePositiveNumber((source as any).diningArea),
      parkingArea: (source as any).parkingArea ?? defaults.parkingArea ?? "",
      ecoFriendlyFacilities: (source as any).ecoFriendlyFacilities ?? defaults.ecoFriendlyFacilities ?? "",
      differentlyAbledFacilities: (source as any).differentlyAbledFacilities ?? defaults.differentlyAbledFacilities ?? "",
      fireEquipmentDetails: (source as any).fireEquipmentDetails ?? defaults.fireEquipmentDetails ?? "",
      certificateValidityYears: (resolvedCertificateYears === "3" ? "3" : "1"),
      nearestHospital: (source as any).nearestHospital ?? defaults.nearestHospital ?? "",
    });

    const amenitiesSource = (source as any).amenities;
    if (amenitiesSource) {
      try {
        const parsedAmenities =
          typeof amenitiesSource === "string" ? JSON.parse(amenitiesSource) : amenitiesSource;
        setSelectedAmenities(parsedAmenities || {});
      } catch {
        setSelectedAmenities({});
      }
    }

    const documentsSource = Array.isArray((source as any).documents) ? (source as any).documents : [];
    if (documentsSource.length > 0) {
      const docs: Record<string, UploadedFileMetadata[]> = {
        revenuePapers: [],
        affidavitSection29: [],
        undertakingFormC: [],
        commercialElectricityBill: [],
        commercialWaterBill: [],
      };
      const photos: UploadedFileMetadata[] = [];
      documentsSource.forEach((doc: any) => {
        const base: UploadedFileMetadata = {
          id: doc.id,
          filePath: doc.fileUrl || doc.filePath,
          fileName: doc.fileName || doc.name || "document",
          fileSize: doc.fileSize || 0,
          mimeType: doc.mimeType || doc.type || "application/octet-stream",
        };
        switch (doc.documentType) {
          case "revenue_papers":
            docs.revenuePapers.push(base);
            break;
          case "affidavit_section_29":
            docs.affidavitSection29.push(base);
            break;
          case "undertaking_form_c":
            docs.undertakingFormC.push(base);
            break;
          case "commercial_electricity_bill":
            docs.commercialElectricityBill.push(base);
            break;
          case "commercial_water_bill":
            docs.commercialWaterBill.push(base);
            break;
          case "property_photo":
            photos.push(base);
            break;
          default:
            break;
        }
      });
    setUploadedDocuments(docs);
      setPropertyPhotos(photos);
    } else {
      setUploadedDocuments({
        revenuePapers: [],
        affidavitSection29: [],
        undertakingFormC: [],
        commercialElectricityBill: [],
        commercialWaterBill: [],
      });
      setPropertyPhotos([]);
    }
    setTimeout(() => {
      form.setValue("district", districtValue, {
        shouldDirty: false,
        shouldValidate: false,
      });
      form.setValue("tehsil", resolvedTehsil, {
        shouldDirty: false,
        shouldValidate: false,
      });
      form.setValue("tehsilOther", resolvedTehsilOther, {
        shouldDirty: false,
        shouldValidate: false,
      });
      setType2RowsSafe(() => buildType2RowsFromForm());
      isHydratingDraft.current = false;
    }, 0);
  };

  const buildDocumentsPayload = () => {
    const normalize = (files: UploadedFileMetadata[], type: string) =>
      files.map((file) => ({
        id: file.id || generateClientId(),
        fileName: file.fileName,
        filePath: file.filePath,
        fileUrl: file.filePath,
        documentType: type,
        fileSize: file.fileSize ?? 0,
        mimeType: file.mimeType || "application/octet-stream",
        name: file.fileName,
        type,
        url: file.filePath,
      }));

    return [
      ...normalize(uploadedDocuments.revenuePapers, "revenue_papers"),
      ...normalize(uploadedDocuments.affidavitSection29, "affidavit_section_29"),
      ...normalize(uploadedDocuments.undertakingFormC, "undertaking_form_c"),
      ...normalize(uploadedDocuments.commercialElectricityBill, "commercial_electricity_bill"),
      ...normalize(uploadedDocuments.commercialWaterBill, "commercial_water_bill"),
      ...normalize(propertyPhotos, "property_photo"),
    ];
  };

  useEffect(() => {
    const normalizedFirst = sanitizeNamePart(ownerFirstName || "").trim();
    const normalizedLast = sanitizeNamePart(ownerLastName || "").trim();
    const combined = [normalizedFirst, normalizedLast].filter(Boolean).join(" ");
    const currentFullName = form.getValues("ownerName");

    if (combined !== currentFullName) {
      form.setValue("ownerName", combined, {
        shouldValidate: step >= 2,
        shouldDirty: Boolean(normalizedFirst || normalizedLast),
      });
    }
  }, [ownerFirstName, ownerLastName, form, step]);

  const singleBedRooms = form.watch("singleBedRooms") || 0;
  const doubleBedRooms = form.watch("doubleBedRooms") || 0;
  const familySuites = form.watch("familySuites") || 0;
  const singleBedBeds = form.watch("singleBedBeds") || 0;
  const doubleBedBeds = form.watch("doubleBedBeds") || 0;
  const familySuiteBeds = form.watch("familySuiteBeds") || 0;
  const attachedWashroomsValue = form.watch("attachedWashrooms") || 0;
  const proposedRoomRate = form.watch("proposedRoomRate") || 0;
  const singleBedRoomRate = form.watch("singleBedRoomRate") || 0;
  const doubleBedRoomRate = form.watch("doubleBedRoomRate") || 0;
  const familySuiteRate = form.watch("familySuiteRate") || 0;
  const totalRooms = singleBedRooms + doubleBedRooms + familySuites;
const totalBeds =
    singleBedRooms * singleBedBeds +
    doubleBedRooms * doubleBedBeds +
    familySuites * familySuiteBeds;
const roomLimitExceeded = totalRooms > MAX_ROOMS_ALLOWED;
const bedLimitExceeded = totalBeds > MAX_BEDS_ALLOWED;
const bathroomsBelowRooms = totalRooms > 0 && attachedWashroomsValue < totalRooms;
useEffect(() => {
  if (syncAttachedBaths) {
    form.setValue("attachedWashrooms", totalRooms, { shouldDirty: true });
  }
}, [syncAttachedBaths, totalRooms, form]);

  // Calculate weighted average rate (2025 Rules - based on total revenue)
  const calculateWeightedAverageRate = (): number => {
    if (totalRooms === 0) return 0;
    
    const totalRevenue = 
      (singleBedRooms * singleBedRoomRate) +
      (doubleBedRooms * doubleBedRoomRate) +
      (familySuites * familySuiteRate);
    
    return Math.round(totalRevenue / totalRooms);
  };

  // Use weighted average if per-room-type rates are set, otherwise fall back to proposedRoomRate (legacy)
  const hasPerRoomTypeRates = singleBedRoomRate > 0 || doubleBedRoomRate > 0 || familySuiteRate > 0;
const effectiveRate = hasPerRoomTypeRates ? calculateWeightedAverageRate() : proposedRoomRate;
const calculatedHighestRoomRate = Math.max(
  singleBedRooms > 0 ? singleBedRoomRate : 0,
  doubleBedRooms > 0 ? doubleBedRoomRate : 0,
  familySuites > 0 ? familySuiteRate : 0,
  !hasPerRoomTypeRates ? proposedRoomRate : 0
);
const highestRoomRate =
  totalRooms > 0
    ? calculatedHighestRoomRate > 0
      ? calculatedHighestRoomRate
      : proposedRoomRate
    : 0;
const highestTariffBucket = highestRoomRate > 0 ? rateToBucket(highestRoomRate) : null;
const highestTariffLabel =
  roomCalcMode === "direct"
    ? highestRoomRate > 0
      ? `${formatShortCurrency(highestRoomRate)}/night`
      : "₹0/night"
    : highestTariffBucket
      ? TARIFF_BUCKETS.find((bucket) => bucket.value === highestTariffBucket)?.label ?? "None selected"
      : "₹0/night";
  const categoryValidation =
    category && totalRooms > 0 && highestRoomRate > 0
      ? validateCategorySelection(category as CategoryType, totalRooms, highestRoomRate, categoryRateBands)
      : null;
  const categoryWarnings = categoryValidation?.warnings ?? [];
  const shouldLockCategoryWarning = lockToRecommendedCategory && categoryWarnings.length > 0;
  const resolvedCategory = (category as CategoryType) || "silver";
  const resolvedCategoryBand = categoryRateBands[resolvedCategory] ?? DEFAULT_CATEGORY_RATE_BANDS[resolvedCategory];
  const suggestedCategory = categoryValidation?.suggestedCategory;
  const type2CategoryConflict =
    roomCalcMode === "direct"
      ? type2Rows.some((row) => {
          const rate = coerceNumber(row.customRate, 0) ?? 0;
          if (rate <= 0) {
            return false;
          }
          const status = evaluateBandStatus(rate, resolvedCategoryBand);
          return status === "below" || status === "above";
        })
      : type2Rows.some((row) => {
          const bucketInfo = TARIFF_BUCKETS.find((bucket) => bucket.value === row.tariffBucket);
          if (!bucketInfo) return false;
          return CATEGORY_ORDER[resolvedCategory] < CATEGORY_ORDER[bucketInfo.minCategory];
        });
const categoryBlocked = Boolean(
  (isCategoryEnforced && categoryValidation && !categoryValidation.isValid) ||
    type2CategoryConflict ||
    shouldLockCategoryWarning,
);
const safetyChecklistFailed = !selectedAmenities.cctv || !selectedAmenities.fireSafety;
const roomGuardrailsFailed =
  isLeaseBlocked ||
  roomLimitExceeded ||
  bedLimitExceeded ||
  bathroomsBelowRooms ||
  categoryBlocked ||
  safetyChecklistFailed ||
  totalRooms === 0;
const isNextDisabled = step === 1
  ? !pincodeIsValid
  : step === 2
    ? propertyOwnership === "leased"
    : step === 3
      ? roomGuardrailsFailed || gstinBlocking
      : step > 3
        ? roomGuardrailsFailed
        : false;

  // Smart category suggestion based on room count + weighted average rate
  const suggestedCategoryValue = totalRooms > 0 && highestRoomRate > 0 
    ? suggestCategory(totalRooms, highestRoomRate, categoryRateBands) 
    : null;
const selectedAmenitiesCount = Object.values(selectedAmenities).filter(Boolean).length;
const applicationNumber = activeHydratedApplication?.applicationNumber ?? null;

const copyApplicationNumber = async () => {
  if (!applicationNumber) return;
  try {
    await navigator.clipboard.writeText(applicationNumber);
    toast({
      title: "Application number copied",
      description: applicationNumber,
    });
  } catch (error) {
    toast({
      title: "Copy failed",
      description: error instanceof Error ? error.message : "Unable to copy application number",
      variant: "destructive",
    });
  }
};

  // Load draft data into form when resuming
  useEffect(() => {
    if (!draftApplication) return;
    const draft = draftApplication;
    setDraftId(draft.id);
    hydrateFormFromSource(draft);

    if (draft.currentPage && draft.currentPage >= 1 && draft.currentPage <= totalSteps) {
      setStep(draft.currentPage);
      setMaxStepReached(draft.currentPage);
    } else {
      setStep(1);
      setMaxStepReached(1);
    }

    const draftKind = draft.applicationKind as ApplicationKind | undefined;
    const isService = isServiceApplication(draftKind);
    toast({
      title: isService
        ? `${getApplicationKindLabel(draftKind)} draft ready`
        : "Draft loaded",
      description: isService
        ? "This request is linked to your approved application. Review and submit once adjustments are complete."
        : "Continue editing your application from where you left off.",
    });
  }, [draftApplication]);

  // Load existing application for corrections
  useEffect(() => {
    if (!correctionData?.application) return;
    const application = correctionData.application;

    if (!isCorrectionRequiredStatus(application.status)) {
      toast({
        title: "Application not editable",
        description: "This application is no longer awaiting corrections.",
        variant: "destructive",
      });
      setLocation(`/applications/${application.id}`);
      return;
    }

    setCorrectionId(application.id);
    hydrateFormFromSource(application);
    setCorrectionAcknowledged(false);
    setDraftId(null);
    setStep(1);
    setMaxStepReached(totalSteps);

    const url = new URL(window.location.href);
    url.searchParams.set("application", application.id);
    url.searchParams.delete("draft");
    window.history.replaceState(null, "", url.pathname + url.search);

    toast({
      title: "Continue with corrections",
      description: "Review each step, update details, and resubmit when ready.",
    });
  }, [correctionData, toast, setLocation]);

  // Auto-populate owner details from user profile (only for new applications, not drafts)
  useEffect(() => {
    if (!userProfile || draftIdFromUrl || correctionIdFromUrl || form.formState.isDirty) {
      return;
    }

    const profileNameParts = splitFullName(userProfile.fullName || "");
    const profileDistrict = userProfile.district || "";
    const profileTehsil = (userProfile.tehsil || "").trim();
    const profileTehsilOptions = profileDistrict ? getTehsilsForDistrict(profileDistrict) : [];
    let defaultTehsilValue = "";
    let defaultTehsilOtherValue = "";

    if (profileTehsil && profileTehsilOptions.includes(profileTehsil)) {
      defaultTehsilValue = profileTehsil;
    } else if (profileTehsil) {
      defaultTehsilValue = "__other";
      defaultTehsilOtherValue = profileTehsil;
    } else if (profileTehsilOptions.length > 0) {
      defaultTehsilValue = profileTehsilOptions[0];
    }

    form.reset({
      propertyName: "",
      locationType: "" as LocationType | "",
      category: "silver",
      proposedRoomRate: 2000,
      singleBedRoomRate: 0,
      doubleBedRoomRate: 2000,
      familySuiteRate: 0,
      projectType: "new_project",
      propertyArea: 0,
      singleBedRooms: 0,
      singleBedBeds: 1,
      singleBedRoomSize: undefined,
      doubleBedRooms: 0,
      doubleBedBeds: 2,
      doubleBedRoomSize: undefined,
      familySuites: 0,
      familySuiteBeds: 4,
      familySuiteSize: undefined,
      attachedWashrooms: 1,
      gstin: "",
      distanceAirport: undefined,
      distanceRailway: undefined,
      distanceCityCenter: undefined,
      distanceShopping: undefined,
      distanceBusStand: undefined,
      lobbyArea: undefined,
      diningArea: undefined,
      parkingArea: "",
      ecoFriendlyFacilities: "",
      differentlyAbledFacilities: "",
      fireEquipmentDetails: "",
      certificateValidityYears: "1",
      nearestHospital: "",
      ownerName: userProfile.fullName || "",
      ownerFirstName: profileNameParts.firstName || "",
      ownerLastName: profileNameParts.lastName || "",
        ownerGender: normalizeGender(userProfile.gender as string) as "male" | "female" | "other",
      ownerMobile: userProfile.mobile || "",
      ownerEmail: userProfile.email || "",
      ownerAadhaar: userProfile.aadhaarNumber || "",
      district: profileDistrict,
      tehsil: defaultTehsilValue,
      tehsilOther: defaultTehsilOtherValue,
      gramPanchayat: userProfile.gramPanchayat || "",
      urbanBody: userProfile.urbanBody || "",
      ward: userProfile.ward || "",
      address: userProfile.address || "",
      pincode: userProfile.pincode || "",
      telephone: userProfile.telephone || "",
    });
  }, [userProfile, draftIdFromUrl, correctionIdFromUrl, form]);

  // Auto-populate distances when district changes (user can override)
  useEffect(() => {
    if (district && DISTRICT_DISTANCES[district]) {
      const defaults = DISTRICT_DISTANCES[district];
      
      // Only auto-fill if fields are undefined (not set), allow intentional zero values
      if (form.getValues("distanceAirport") === undefined) {
        form.setValue("distanceAirport", defaults.airport);
      }
      if (form.getValues("distanceRailway") === undefined) {
        form.setValue("distanceRailway", defaults.railway);
      }
      if (form.getValues("distanceCityCenter") === undefined) {
        form.setValue("distanceCityCenter", defaults.cityCenter);
      }
      if (form.getValues("distanceShopping") === undefined) {
        form.setValue("distanceShopping", defaults.shopping);
      }
      if (form.getValues("distanceBusStand") === undefined) {
        form.setValue("distanceBusStand", defaults.busStand);
      }
    }
  }, [district]);

  useEffect(() => {
    if (step !== 1 || isHydratingDraft.current) {
      return;
    }
    if (!form.getValues("tehsil") && lastHydratedTehsil.current.value) {
      form.setValue("tehsil", lastHydratedTehsil.current.value, {
        shouldDirty: false,
        shouldValidate: true,
      });
      form.setValue("tehsilOther", lastHydratedTehsil.current.other, {
        shouldDirty: false,
        shouldValidate: true,
      });
    }
  }, [form, step]);

  const calculateFee = () => {
    // Detect Pangi sub-division (Chamba district, Pangi tehsil)
  const isPangiSubDivision = district === "Chamba" && tehsilForRules === "Pangi";
    
    // Use new 2025 fee calculator
    const feeBreakdown = calculateHomestayFee({
      category: category as CategoryType,
      locationType: resolvedLocationType,
      validityYears: parseInt(certificateValidityYears) as 1 | 3,
      ownerGender: (ownerGender || "male") as "male" | "female" | "other",
      isPangiSubDivision,
    });

    return {
      baseFee: feeBreakdown.baseFee,
      totalBeforeDiscounts: feeBreakdown.totalBeforeDiscounts,
      validityDiscount: feeBreakdown.validityDiscount,
      femaleOwnerDiscount: feeBreakdown.femaleOwnerDiscount,
      pangiDiscount: feeBreakdown.pangiDiscount,
      totalDiscount: feeBreakdown.totalDiscount,
      totalFee: feeBreakdown.finalFee,
      savingsAmount: feeBreakdown.savingsAmount,
      savingsPercentage: feeBreakdown.savingsPercentage,
      // Legacy fields for backward compatibility
      gstAmount: 0,
      perRoomFee: 0,
    };
  };

  // Draft save mutation - bypasses form validation to allow partial saves
  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      if (isCorrectionMode) {
        toast({
          title: "Drafts unavailable",
          description: "Use final submission instead. Draft saving is disabled while updating an existing application.",
        });
        return null;
      }
      // Get raw form values without triggering validation
      const rawFormData = form.getValues();
      
      // Validate with relaxed draft schema (all fields optional)
      const validatedData = draftSchema.parse(rawFormData);
      
      const fees = calculateFee();
      const draftTehsilOtherTrimmed = typeof validatedData.tehsilOther === "string" ? validatedData.tehsilOther.trim() : "";
      const resolvedDraftTehsil =
        validatedData.tehsil === "__other"
          ? draftTehsilOtherTrimmed
          : (validatedData.tehsil ?? "");
      const resolvedDraftTehsilOther =
        validatedData.tehsil === "__other" ? draftTehsilOtherTrimmed : "";
      const documentsPayload = buildDocumentsPayload();
      const totalDocumentBytes = documentsPayload.reduce(
        (sum, doc) => sum + (doc.fileSize ?? 0),
        0,
      );
      if (totalDocumentBytes > maxTotalUploadBytes) {
        throw new Error(
          `Combined document size ${formatBytes(totalDocumentBytes)} exceeds ${uploadPolicy.totalPerApplicationMB} MB limit`,
        );
      }
      const payload = {
        ...validatedData,
        tehsil: resolvedDraftTehsil,
        tehsilOther: resolvedDraftTehsilOther || "",
        ownerEmail: validatedData.ownerEmail || undefined,
        amenities: selectedAmenities,
        // 2025 Fee Structure
        baseFee: fees.baseFee.toString(),
        totalBeforeDiscounts: fees.totalBeforeDiscounts?.toString() || "0",
        validityDiscount: fees.validityDiscount?.toFixed(2) || "0",
        femaleOwnerDiscount: fees.femaleOwnerDiscount?.toFixed(2) || "0",
        pangiDiscount: fees.pangiDiscount?.toFixed(2) || "0",
        totalDiscount: fees.totalDiscount?.toFixed(2) || "0",
        totalFee: fees.totalFee.toFixed(2),
        // Legacy fields for backward compatibility
        perRoomFee: "0",
        gstAmount: "0",
        totalRooms,
        certificateValidityYears: parseInt(certificateValidityYears),
        isPangiSubDivision: district === "Chamba" && resolvedDraftTehsil === "Pangi",
        currentPage: step, // Save the current page/step for resume functionality
        documents: documentsPayload,
      };

      if (draftId) {
        // Update existing draft
        const response = await apiRequest("PATCH", `/api/applications/${draftId}/draft`, payload);
        return response.json();
      } else {
        // Create new draft
        const response = await fetch("/api/applications/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(payload),
        });

        if (response.status === 409) {
          const data = await response.json().catch(() => ({}));
          const error = new Error(data?.message || "An application already exists for this owner.");
          (error as any).status = 409;
          (error as any).data = data;
          throw error;
        }

        if (!response.ok) {
          const text = (await response.text()) || response.statusText;
          throw new Error(text);
        }

        return response.json();
      }
    },
    onSuccess: (data) => {
      if (!data?.application) {
        return;
      }
      if (!draftId) {
        setDraftId(data.application.id);
        const url = new URL(window.location.href);
        url.searchParams.set("draft", data.application.id);
        window.history.replaceState(null, "", url.pathname + url.search);
      }
      // Invalidate and refetch to ensure dashboard shows the draft immediately
      queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
      queryClient.refetchQueries({ queryKey: ["/api/applications"] });
      toast({
        title: "Draft saved!",
        description: "Your progress has been saved. You can continue anytime.",
      });
    },
    onError: (error: any) => {
      if (error?.status === 409) {
        toast({
          title: "Existing application found",
          description: error?.data?.message || "You already have an application on file. Please continue with the existing application.",
        });
        const existingId = error?.data?.existingApplicationId;
        if (existingId) {
          navigate(`/applications/${existingId}`);
        }
        return;
      }
      toast({
        title: "Failed to save draft",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

const submitApplicationMutation = useMutation({
  mutationFn: async (formData: ApplicationForm) => {
      const fees = calculateFee();
      const documentsPayload = buildDocumentsPayload();
      const totalDocumentBytes = documentsPayload.reduce(
        (sum, doc) => sum + (doc.fileSize ?? 0),
        0,
      );
      if (totalDocumentBytes > maxTotalUploadBytes) {
        throw new Error(
          `Combined document size ${formatBytes(totalDocumentBytes)} exceeds ${uploadPolicy.totalPerApplicationMB} MB limit`,
        );
      }
      const tehsilOtherTrimmed = typeof formData.tehsilOther === "string" ? formData.tehsilOther.trim() : "";
      const resolvedTehsil =
        formData.tehsil === "__other"
          ? tehsilOtherTrimmed
          : formData.tehsil;
      const normalizedTehsilOther = formData.tehsil === "__other" ? tehsilOtherTrimmed : "";

      if (!resolvedTehsil) {
        throw new Error("Tehsil is required");
      }

      const totalRoomsCount =
        (formData.singleBedRooms || 0) +
        (formData.doubleBedRooms || 0) +
        (formData.familySuites || 0);
      const totalBedsCalculated =
        (formData.singleBedRooms || 0) * (formData.singleBedBeds || 0) +
        (formData.doubleBedRooms || 0) * (formData.doubleBedBeds || 0) +
        (formData.familySuites || 0) * (formData.familySuiteBeds || 0);
      if (totalRoomsCount > MAX_ROOMS_ALLOWED) {
        throw new Error(`Total rooms cannot exceed ${MAX_ROOMS_ALLOWED}.`);
      }

      if (totalBedsCalculated > MAX_BEDS_ALLOWED) {
        throw new Error(`Total beds cannot exceed ${MAX_BEDS_ALLOWED}. Please adjust the bed counts per room type.`);
      }
      if (totalRoomsCount > 0 && (formData.attachedWashrooms || 0) < totalRoomsCount) {
        throw new Error("Ensure the number of attached washrooms is at least equal to the total rooms.");
      }

      if (isCategoryEnforced && categoryValidation && !categoryValidation.isValid) {
        throw new Error(
          categoryValidation.errors.join(" ") ||
            "Category selection must meet the required thresholds before submission.",
        );
      }

      if (isCorrectionMode && correctionId) {
        const normalizedGramPanchayat = normalizeOptionalString(formData.gramPanchayat);
        const normalizedGramPanchayatOther = normalizeOptionalString(formData.gramPanchayatOther);
        const normalizedUrbanBody = normalizeOptionalString(formData.urbanBody);
        const normalizedUrbanBodyOther = normalizeOptionalString(formData.urbanBodyOther);
        const normalizedWard = normalizeOptionalString(formData.ward);

        const correctionPayload = {
          propertyName: formData.propertyName,
          locationType: formData.locationType,
          district: formData.district,
          tehsil: resolvedTehsil,
          tehsilOther: normalizedTehsilOther || "",
          gramPanchayat: normalizedGramPanchayat ?? "",
          gramPanchayatOther: normalizedGramPanchayatOther ?? "",
          urbanBody: normalizedUrbanBody ?? "",
          urbanBodyOther: normalizedUrbanBodyOther ?? "",
          ward: normalizedWard ?? "",
          address: formData.address,
          pincode: formData.pincode,
          telephone: normalizeOptionalString(formData.telephone) ?? undefined,
          ownerName: formData.ownerName,
          ownerFirstName: formData.ownerFirstName,
          ownerLastName: formData.ownerLastName,
          ownerGender: formData.ownerGender,
          ownerMobile: formData.ownerMobile,
          ownerEmail: normalizeOptionalString(formData.ownerEmail) ?? undefined,
          ownerAadhaar: formData.ownerAadhaar,
          propertyOwnership: formData.propertyOwnership,
          category: formData.category,
          proposedRoomRate: formData.proposedRoomRate,
          singleBedRoomRate: formData.singleBedRoomRate,
          doubleBedRoomRate: formData.doubleBedRoomRate,
          familySuiteRate: formData.familySuiteRate,
          projectType: formData.projectType,
          propertyArea: formData.propertyArea,
          singleBedRooms: formData.singleBedRooms,
          singleBedBeds: formData.singleBedBeds,
          singleBedRoomSize: formData.singleBedRoomSize,
          doubleBedRooms: formData.doubleBedRooms,
          doubleBedBeds: formData.doubleBedBeds,
          doubleBedRoomSize: formData.doubleBedRoomSize,
          familySuites: formData.familySuites,
          familySuiteBeds: formData.familySuiteBeds,
          familySuiteSize: formData.familySuiteSize,
          attachedWashrooms: formData.attachedWashrooms,
          gstin: normalizeOptionalString(formData.gstin) ?? undefined,
          certificateValidityYears: parseInt(certificateValidityYears),
          isPangiSubDivision: district === "Chamba" && resolvedTehsil === "Pangi",
          distanceAirport: formData.distanceAirport,
          distanceRailway: formData.distanceRailway,
          distanceCityCenter: formData.distanceCityCenter,
          distanceShopping: formData.distanceShopping,
          distanceBusStand: formData.distanceBusStand,
          lobbyArea: formData.lobbyArea,
          diningArea: formData.diningArea,
          parkingArea: normalizeOptionalString(formData.parkingArea) ?? undefined,
          ecoFriendlyFacilities: normalizeOptionalString(formData.ecoFriendlyFacilities) ?? undefined,
          differentlyAbledFacilities: normalizeOptionalString(formData.differentlyAbledFacilities) ?? undefined,
          fireEquipmentDetails: normalizeOptionalString(formData.fireEquipmentDetails) ?? undefined,
          nearestHospital: normalizeOptionalString(formData.nearestHospital) ?? undefined,
          amenities: selectedAmenities,
          baseFee: fees.baseFee,
          totalBeforeDiscounts: fees.totalBeforeDiscounts,
          validityDiscount: fees.validityDiscount,
          femaleOwnerDiscount: fees.femaleOwnerDiscount,
          pangiDiscount: fees.pangiDiscount,
          totalDiscount: fees.totalDiscount,
          totalFee: fees.totalFee,
          perRoomFee: 0,
          gstAmount: 0,
          totalRooms,
          documents: documentsPayload,
        };

        const response = await apiRequest("PATCH", `/api/applications/${correctionId}` , correctionPayload);
        return response.json();
      }

      const requiresGstinSubmission = formData.category === "gold" || formData.category === "diamond";
      const sanitizedGstinValue = requiresGstinSubmission
        ? sanitizeGstinInput(formData.gstin ?? "")
        : undefined;

      const normalizedFormData = {
        ...formData,
        tehsil: resolvedTehsil,
        tehsilOther: normalizedTehsilOther || "",
        gstin: sanitizedGstinValue,
      };

      const normalizedGramPanchayat = normalizeOptionalString(formData.gramPanchayat);
      const normalizedGramPanchayatOther = normalizeOptionalString(formData.gramPanchayatOther);
      const normalizedUrbanBody = normalizeOptionalString(formData.urbanBody);
      const normalizedUrbanBodyOther = normalizeOptionalString(formData.urbanBodyOther);
      const normalizedWard = normalizeOptionalString(formData.ward);

      const payload = {
        ...normalizedFormData,
        gstin: sanitizedGstinValue,
        ownerEmail: normalizeOptionalString(formData.ownerEmail) || undefined,
        telephone: normalizeOptionalString(formData.telephone) || undefined,
        gramPanchayat: normalizedGramPanchayat ?? undefined,
        gramPanchayatOther: normalizedGramPanchayatOther ?? undefined,
        urbanBody: normalizedUrbanBody ?? undefined,
        urbanBodyOther: normalizedUrbanBodyOther ?? undefined,
        ward: normalizedWard ?? undefined,
        propertyOwnership: formData.propertyOwnership,
        parkingArea: normalizeOptionalString(formData.parkingArea) || undefined,
        ecoFriendlyFacilities: normalizeOptionalString(formData.ecoFriendlyFacilities) || undefined,
        differentlyAbledFacilities: normalizeOptionalString(formData.differentlyAbledFacilities) || undefined,
        fireEquipmentDetails: normalizeOptionalString(formData.fireEquipmentDetails) || undefined,
        nearestHospital: normalizeOptionalString(formData.nearestHospital) || undefined,
        amenities: selectedAmenities,
        baseFee: fees.baseFee.toString(),
        totalBeforeDiscounts: fees.totalBeforeDiscounts?.toString() || "0",
        validityDiscount: fees.validityDiscount?.toFixed(2) || "0",
        femaleOwnerDiscount: fees.femaleOwnerDiscount?.toFixed(2) || "0",
        pangiDiscount: fees.pangiDiscount?.toFixed(2) || "0",
        totalDiscount: fees.totalDiscount?.toFixed(2) || "0",
        totalFee: fees.totalFee.toFixed(2),
        perRoomFee: "0",
        gstAmount: "0",
        totalRooms,
        certificateValidityYears: parseInt(certificateValidityYears),
        isPangiSubDivision: district === "Chamba" && resolvedTehsil === "Pangi",
        status: "submitted",
        submittedAt: new Date().toISOString(),
        documents: documentsPayload,
      };

      const response = await apiRequest("POST", "/api/applications", payload);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
      toast({
        title: isCorrectionMode ? "Application resubmitted" : "Application submitted successfully!",
        description: isCorrectionMode
          ? "Your updates were sent back to the department for review."
          : "Your homestay application has been submitted for review.",
      });
      if (isCorrectionMode && correctionId) {
        setLocation(`/applications/${correctionId}`);
      } else {
        setLocation("/dashboard");
      }
    },
    onError: (error: any) => {
      toast({
        title: isCorrectionMode ? "Failed to resubmit application" : "Failed to create application",
        description: error.message || "Please try again",
        variant: "destructive",
      });
  },
});

  const enforceGstinRequirements = (options?: {
    redirectToStep3?: boolean;
    focusField?: boolean;
    showToast?: boolean;
  }) => {
    const categoryValue = form.getValues("category");
    if (categoryValue !== "gold" && categoryValue !== "diamond") {
      return true;
    }

    const gstinValue = form.getValues("gstin");
    const normalizedGstin = sanitizeGstinInput(gstinValue ?? "");

    const guideUser = () => {
      if (options?.redirectToStep3) {
        setStep(3);
      }
      if (options?.showToast) {
        toast({
          title: "GSTIN required before submission",
          description: "Fill the GSTIN on the Rooms & Category step to continue.",
        });
      }
      if (options?.focusField) {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLInputElement>('[data-testid="input-gstin"]')
            ?.focus();
        });
      }
    };

    if (!normalizedGstin) {
      form.setError("gstin", {
        type: "manual",
        message: "GSTIN is required for Diamond and Gold categories",
      });
      guideUser();
      return false;
    }

    if (normalizedGstin.length !== 15 || !/^[0-9A-Z]{15}$/.test(normalizedGstin)) {
      form.setError("gstin", {
        type: "manual",
        message: "GSTIN must be 15 characters (numbers and capital letters only)",
      });
      guideUser();
      return false;
    }

    if (normalizedGstin !== gstinValue) {
      form.setValue("gstin", normalizedGstin, { shouldValidate: true, shouldDirty: true });
    } else {
      form.clearErrors("gstin");
    }

    return true;
  };

  const onSubmit = async (data: ApplicationForm) => {
    console.log("onSubmit called - Step:", step, "Total Steps:", totalSteps);
    console.log("Form data:", data);
    console.log("Form errors:", form.formState.errors);
    
    // Only allow submission on the final step
    if (step !== totalSteps) {
      console.warn("Form submission blocked - not on final step");
      return;
    }

    if (!enforceGstinRequirements({ redirectToStep3: true, focusField: true, showToast: true })) {
      return;
    }

    const isValid = await form.trigger(undefined, { shouldFocus: true });
    if (!isValid) {
      return;
    }

    if (isCorrectionMode && !correctionAcknowledged) {
      toast({
        title: "Confirm corrections",
        description: "Please confirm that you have addressed all issues before resubmitting.",
        variant: "destructive",
      });
      return;
    }
    
    console.log("Submitting application...");
    submitApplicationMutation.mutate(data);
  };

  const nextStep = async () => {
    // Step 1: Validate Property Details
    if (step === 1) {
      const isValid = await form.trigger([
        "propertyName",
        "address",
        "district",
        "pincode",
        "locationType"
      ]);
      if (!isValid) {
        toast({
          title: "Please complete all required fields",
          description: "Fill in all mandatory property details before proceeding",
          variant: "destructive"
        });
        return;
      }

      const selectedTehsil = form.getValues("tehsil");
      if (selectedTehsil === "__other") {
        const isOtherValid = await form.trigger("tehsilOther");
        if (!isOtherValid) {
          toast({
            title: "Enter tehsil name",
            description: "Provide the tehsil or sub-division name when using the manual option",
            variant: "destructive",
          });
          return;
        }
      }
    }

    // Step 2: Validate Owner Information
    if (step === 2) {
      const isValid = await form.trigger([
        "ownerFirstName",
        "ownerLastName",
        "ownerName",
        "ownerMobile",
        "ownerEmail",
        "ownerAadhaar",
        "ownerGender",
        "propertyOwnership"
      ]);
      if (!isValid) {
        toast({
          title: "Please complete all required fields",
          description: "Fill in all mandatory owner information before proceeding",
          variant: "destructive"
        });
        return;
      }
    }

    // Step 3: Validate Room Details & Category
    if (step === 3) {
      const category = form.getValues("category");
      const fieldsToValidate: Array<keyof ApplicationForm> = [
        "category",
        "proposedRoomRate",
        "projectType",
        "propertyArea",
        "singleBedRooms",
        "singleBedBeds",
        "doubleBedRooms",
        "doubleBedBeds",
        "familySuites",
        "familySuiteBeds",
        "attachedWashrooms"
      ];
      
      // Add GSTIN validation for Diamond/Gold categories
      if (category === "diamond" || category === "gold") {
        fieldsToValidate.push("gstin");
        if (!enforceGstinRequirements({ focusField: true })) {
          return;
        }
      }
      
      const isValid = await form.trigger(fieldsToValidate);
      if (!isValid) {
        toast({
          title: "Please complete all required fields",
          description: "Fill in all mandatory room details before proceeding",
          variant: "destructive"
        });
        return;
      }

      // Validate total beds <= 12
      const singleRooms = form.getValues("singleBedRooms") || 0;
      const doubleRooms = form.getValues("doubleBedRooms") || 0;
      const suiteRooms = form.getValues("familySuites") || 0;
      const totalRoomsCurrent = singleRooms + doubleRooms + suiteRooms;
      if (totalRoomsCurrent > MAX_ROOMS_ALLOWED) {
        toast({
          title: "Room limit exceeded",
          description: `HP Homestay Rules permit a maximum of ${MAX_ROOMS_ALLOWED} rooms. You currently have ${totalRoomsCurrent}.`,
          variant: "destructive"
        });
        return;
      }

      const totalBeds = (singleRooms * (form.getValues("singleBedBeds") || 0)) +
                        (doubleRooms * (form.getValues("doubleBedBeds") || 0)) +
                        (suiteRooms * (form.getValues("familySuiteBeds") || 0));
      if (totalBeds > MAX_BEDS_ALLOWED) {
        toast({
          title: "Maximum beds exceeded",
          description: `Total beds across all room types cannot exceed ${MAX_BEDS_ALLOWED}. Please adjust the bed counts.`,
          variant: "destructive"
        });
        return;
      }

      const attachedBaths = form.getValues("attachedWashrooms") || 0;
      if (totalRoomsCurrent > 0 && attachedBaths < totalRoomsCurrent) {
        toast({
          title: "Attached washrooms required",
          description: "Ensure each room has an attached washroom before proceeding.",
          variant: "destructive",
        });
        return;
      }

      if (!selectedAmenities.cctv || !selectedAmenities.fireSafety) {
        toast({
          title: "Mandatory safety items missing",
          description: "Install CCTV coverage and fire-safety equipment before continuing.",
          variant: "destructive",
        });
        return;
      }

      if (isCategoryEnforced && categoryValidation && !categoryValidation.isValid) {
        toast({
          title: "Category requirements not met",
          description:
            categoryValidation.errors.join(" ") ||
            "Adjust tariffs or selected category to satisfy the mandatory criteria.",
          variant: "destructive",
        });
        return;
      }
    }

    // Step 4: Validate Distances & Public Areas (all optional, can proceed)
    if (step === 4) {
      // No mandatory fields on this step, can proceed
    }

    // Step 5: Validate Documents (ANNEXURE-II)
    if (step === 5) {
      const missingDocs = [];
      if (uploadedDocuments.revenuePapers.length === 0) missingDocs.push("Revenue Papers");
      if (uploadedDocuments.affidavitSection29.length === 0) missingDocs.push("Affidavit under Section 29");
      if (uploadedDocuments.undertakingFormC.length === 0) missingDocs.push("Undertaking in Form-C");
      if (requiresCommercialUtilityProof) {
        if (uploadedDocuments.commercialElectricityBill.length === 0) missingDocs.push("Commercial electricity bill");
        if (uploadedDocuments.commercialWaterBill.length === 0) missingDocs.push("Commercial water bill");
      }
      if (propertyPhotos.length < 2) missingDocs.push("Property Photos (minimum 2)");
      
      if (missingDocs.length > 0) {
        toast({
          title: "Required ANNEXURE-II documents missing",
          description: `Please upload: ${missingDocs.join(", ")}`,
          variant: "destructive"
        });
        return;
      }
    }
    
    if (step < totalSteps) {
      const newStep = step + 1;
      setStep(newStep);
      setMaxStepReached(Math.max(maxStepReached, newStep));
    }
  };

  const prevStep = () => {
    if (step > 1) setStep(step - 1);
  };

  const getCategoryBadge = (cat: string) => {
    const config = {
      diamond: { label: "Diamond", variant: "default" as const },
      gold: { label: "Gold", variant: "secondary" as const },
      silver: { label: "Silver", variant: "outline" as const },
    };
    return config[cat as keyof typeof config];
  };

  if (!userData?.user) {
    return null;
  }

  const fees = calculateFee();

  const handleStepClick = (targetStep: number) => {
    if (targetStep <= maxStepReached) {
      setStep(targetStep);
    }
  };

  // Combine form data with uploaded documents for progress tracking
  const combinedFormData = {
    ...form.getValues(),
    revenuePapers: uploadedDocuments.revenuePapers,
    affidavitSection29: uploadedDocuments.affidavitSection29,
    undertakingFormC: uploadedDocuments.undertakingFormC,
    commercialElectricityBill: uploadedDocuments.commercialElectricityBill,
    commercialWaterBill: uploadedDocuments.commercialWaterBill,
    propertyPhotos: propertyPhotos,
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-5xl mx-auto">
        {isCorrectionMode && correctionId && (
          <div className="mb-6 border border-amber-200 bg-amber-50/80 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <p className="font-semibold text-amber-800">You are updating application #{(correctionId?.slice(0, 8) || '').toUpperCase()}…</p>
            </div>
            <p className="text-sm text-amber-700">
              All previous details are pre-filled. Review each step, upload corrected documents, and resubmit to continue the approval workflow.
            </p>
          </div>
        )}

        {isServiceDraft && activeDraftApplication && (
          <Alert className="mb-6 border-sky-200 bg-sky-50">
            <AlertTitle className="flex items-center gap-2">
              <ApplicationKindBadge kind={activeApplicationKind} showDefault />
              {getApplicationKindLabel(activeApplicationKind)} draft
            </AlertTitle>
            <AlertDescription>
              {activeApplicationKind === "renewal"
                ? "You are renewing an approved certificate. Property and ownership details are locked to prevent accidental edits."
                : activeApplicationKind === "add_rooms"
                ? "You are requesting to add rooms to the approved inventory. Update Step 3 to capture the additional rooms."
                : "You are requesting to delete rooms from the approved inventory. Verify the counts below and provide the updated documents."}
            </AlertDescription>
            <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
              <p>
                <span className="font-medium">Linked application:</span>{" "}
                {parentApplicationNumber || "—"}
              </p>
              <p>
                <span className="font-medium">Certificate #:</span>{" "}
                {parentCertificateNumber || "—"}
              </p>
              <p>
                <span className="font-medium">Certificate valid upto:</span>{" "}
                {formatDateDisplay(inheritedCertificateExpiry)}
              </p>
              <p>
                <span className="font-medium">Current rooms:</span>{" "}
                {activeDraftApplication.totalRooms} total
              </p>
              {requestedRooms && (
                <p>
                  <span className="font-medium">Target rooms:</span>{" "}
                  {requestedRooms.total} total (S:{requestedRooms.single ?? activeDraftApplication.singleBedRooms} · D:{requestedRooms.double ?? activeDraftApplication.doubleBedRooms} · F:{requestedRooms.family ?? activeDraftApplication.familySuites})
                </p>
              )}
              {serviceContext?.renewalWindow && (
                <p>
                  <span className="font-medium">Renewal window:</span>{" "}
                  {formatDateDisplay(serviceContext.renewalWindow.start)} – {formatDateDisplay(serviceContext.renewalWindow.end)}
                </p>
              )}
              {typeof requestedRoomDelta === "number" && (
                <p>
                  <span className="font-medium">Room delta:</span>{" "}
                  {requestedRoomDelta > 0 ? `+${requestedRoomDelta}` : requestedRoomDelta}
                </p>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
              {parentApplicationId && (
                <Button variant="outline" size="sm" onClick={() => setLocation(`/applications/${parentApplicationId}`)}>
                  View approved record
                </Button>
              )}
              {serviceNote && (
                <span className="italic">
                  Note: {serviceNote}
                </span>
              )}
            </div>
        </Alert>
      )}

        {applicationNumber && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-md border bg-muted/40 px-4 py-3 mb-4">
            <div className="text-sm text-muted-foreground">
              Application #:{" "}
              <span className="font-semibold text-foreground">{applicationNumber}</span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="gap-2"
              onClick={copyApplicationNumber}
              type="button"
            >
              <Copy className="h-4 w-4" />
              Copy
            </Button>
          </div>
        )}

      <ApplicationStepper
        currentStep={step}
        maxStepReached={maxStepReached}
          totalSteps={totalSteps}
          formData={combinedFormData}
          onStepClick={handleStepClick}
          steps={STEP_CONFIG}
        />

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div ref={stepTopRef} />
            {step === 1 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2 mb-2">
                    <Home className="w-5 h-5 text-primary" />
                    <CardTitle>Property Details</CardTitle>
                  </div>
                  <CardDescription>Basic information about your homestay property</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {isServiceDraft && (
                    <p className="text-sm text-muted-foreground">
                      Property identity is inherited from your approved application. Start a new registration if structural details need to change.
                    </p>
                  )}
                  <fieldset disabled={isServiceDraft} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="propertyName"
                      rules={{ required: "Property name is required" }}
                      render={({ field, fieldState }) => (
                        <FormItem>
                          <FormLabel>
                            Homestay Name <span className="text-destructive">*</span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder="e.g., Himalayan View Homestay"
                              data-testid="input-property-name"
                              aria-invalid={fieldState.invalid}
                              className={fieldState.invalid ? "border-destructive focus-visible:ring-destructive" : ""}
                              {...field}
                            />
                          </FormControl>
                          <FormDescription>Choose a memorable name for your homestay</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="projectType"
                      rules={{ required: "Property type is required" }}
                      render={({ field, fieldState }) => (
                        <FormItem>
                          <FormLabel>
                            New Registration <span className="text-destructive">*</span>
                          </FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger
                                aria-invalid={fieldState.invalid}
                                className={fieldState.invalid ? "border-destructive focus-visible:ring-destructive" : ""}
                              >
                                <SelectValue placeholder="Select registration type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {PROJECT_TYPE_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormDescription>Submit a fresh homestay registration.</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* LGD Hierarchical Address - State, District & Tehsil */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <FormLabel>State</FormLabel>
                      <Input value={HP_STATE} readOnly disabled className="bg-muted/60" aria-readonly />
                      <p className="text-xs text-muted-foreground">Portal currently supports Himachal Pradesh only.</p>
                    </div>

                    <FormField
                      control={form.control}
                      name="district"
                      rules={{ required: "District is required" }}
                      render={({ field, fieldState }) => (
                        <FormItem>
                          <FormLabel>
                            District <span className="text-destructive">*</span>
                          </FormLabel>
                          <Select
                            onValueChange={(value) => {
                              field.onChange(value);
                              if (isHydratingDraft.current) {
                                return;
                              }

                              form.setValue('gramPanchayat', '');
                              form.setValue('urbanBody', '');
                              form.setValue('ward', '');
                              form.clearErrors("ward");

                              const tehsilOptions = getTehsilsForDistrict(value);
                              const nextTehsilValue =
                                tehsilOptions.length === 0 ? '__other' : '';
                              form.setValue('tehsil', nextTehsilValue, {
                                shouldDirty: false,
                                shouldValidate: step >= 1,
                              });
                              form.setValue('tehsilOther', '', {
                                shouldDirty: false,
                                shouldValidate: step >= 1,
                              });
                            }}
                            value={field.value || undefined}
                          >
                            <FormControl>
                              <SelectTrigger
                                data-testid="select-district"
                                className={fieldState.invalid ? "border-destructive focus-visible:ring-destructive" : ""}
                                aria-invalid={fieldState.invalid}
                              >
                                <SelectValue placeholder="Select district" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {HP_DISTRICTS.map((district) => (
                                <SelectItem key={district} value={district}>
                                  {district}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormDescription>Select your district first</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="tehsil"
                      render={({ field, fieldState }) => (
                        <FormItem>
                          <FormLabel>
                            Tehsil <span className="text-destructive">*</span>
                          </FormLabel>
                          {(() => {
                            const districtValue = watchedDistrict || '';
                            const fallbackTehsils = getTehsilsForDistrict(districtValue);
                            const currentTehsil = field.value;
                            const includeCurrentValue =
                              currentTehsil &&
                              typeof currentTehsil === "string" &&
                              !fallbackTehsils.includes(currentTehsil);

                            return (
                              <Select
                                onValueChange={(value) => {
                                  const previousTehsil = form.getValues('tehsil');
                                  field.onChange(value);

                                  if (isHydratingDraft.current) {
                                    return;
                                  }

                                  const tehsilChanged = value !== previousTehsil;
                                    if (!isHydratingDraft.current && tehsilChanged) {
                                      form.setValue('gramPanchayat', '', { shouldDirty: false, shouldValidate: step >= 1 });
                                      form.setValue('urbanBody', '', { shouldDirty: false, shouldValidate: step >= 1 });
                                      form.setValue('ward', '', { shouldDirty: false, shouldValidate: step >= 1 });
                                      form.clearErrors("ward");
                                    }

                                  if (!isHydratingDraft.current && value !== '__other') {
                                    form.setValue('tehsilOther', '', { shouldDirty: false, shouldValidate: step >= 1 });
                                  }
                                }}
                                value={field.value || undefined}
                                disabled={!districtValue}
                              >
                                <FormControl>
                                  <SelectTrigger
                                    data-testid="select-tehsil"
                                    className={fieldState.invalid ? "border-destructive focus-visible:ring-destructive" : ""}
                                    aria-invalid={fieldState.invalid}
                                  >
                                    <SelectValue placeholder="Select tehsil" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {fallbackTehsils.map((tehsil) => (
                                    <SelectItem key={tehsil} value={tehsil}>
                                      {tehsil}
                                    </SelectItem>
                                  ))}
                                  <SelectItem value="__other">Other (Manual Entry)</SelectItem>
                                  {includeCurrentValue && (
                                    <SelectItem key={currentTehsil} value={currentTehsil}>
                                      {currentTehsil}
                                    </SelectItem>
                                  )}
                                </SelectContent>
                              </Select>
                            );
                          })()}
                          <FormDescription>Select tehsil after district</FormDescription>
                          <FormMessage />
                          {form.watch('tehsil') === '__other' && (
                            <FormField
                              control={form.control}
                              name="tehsilOther"
                              rules={{ required: "Please enter the tehsil name" }}
                              render={({ field, fieldState }) => (
                                <FormItem className="mt-3">
                                  <FormLabel>Manual Tehsil Entry <span className="text-destructive">*</span></FormLabel>
                                  <FormControl>
                                    <Input
                                      placeholder="Type tehsil or subdivision name"
                                      data-testid="input-tehsil-other"
                                      value={field.value ?? ""}
                                      onChange={(event) => field.onChange(event.target.value)}
                                      aria-invalid={fieldState.invalid}
                                    />
                                  </FormControl>
                                  <FormDescription>Provide the correct tehsil if it is not listed above.</FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          )}
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="locationType"
                    rules={{ required: "Location type is required" }}
                    render={({ field, fieldState }) => (
                      <FormItem>
                        <FormLabel>
                          Location Type (affects registration fee) <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          onValueChange={(value) => {
                            field.onChange(value);
                            if (value === "gp") {
                              form.setValue("urbanBody", "", { shouldDirty: false, shouldValidate: step >= 1 });
                                  form.setValue("ward", "", { shouldDirty: false, shouldValidate: step >= 1 });
                                  form.clearErrors("ward");
                            }
                          }}
                          value={field.value || undefined}
                        >
                          <FormControl>
                            <SelectTrigger
                              data-testid="select-location-type"
                              className={fieldState.invalid ? "border-destructive focus-visible:ring-destructive" : ""}
                              aria-invalid={fieldState.invalid}
                            >
                              <SelectValue placeholder="Select location type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {LOCATION_TYPES.map((type) => (
                              <SelectItem key={type.value} value={type.value}>
                                {type.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormDescription>Rural (GP) or Urban (MC/TCP) - Required for fee calculation</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {gramFieldConfig && (
                    <FormField
                      control={form.control}
                      name="gramPanchayat"
                      rules={{
                        validate: (value) => {
                          if (!value?.trim()) {
                            return gramFieldConfig.requiredMessage;
                          }
                          return true;
                        },
                      }}
                      render={({ field, fieldState }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-1">
                            {gramFieldConfig.label}
                            <span className="text-destructive">*</span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder={gramFieldConfig.placeholder}
                              data-testid="input-gram-panchayat"
                              value={field.value ?? ""}
                              onChange={(event) => field.onChange(event.target.value)}
                              aria-invalid={fieldState.invalid}
                            />
                          </FormControl>
                          <FormDescription>{gramFieldConfig.description}</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {/* Conditional: Urban Address (MC/TCP) */}
                  {(locationType === 'mc' || locationType === 'tcp') && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="urbanBody"
                        rules={{ required: "Urban local body is required" }}
                        render={({ field, fieldState }) => (
                          <FormItem>
                              <FormLabel>
                                {urbanBodyConfig.label} <span className="text-destructive">*</span>
                              </FormLabel>
                              <FormControl>
                                <Input
                                  placeholder={urbanBodyConfig.placeholder}
                                  data-testid="input-urban-body"
                                  value={field.value ?? ""}
                                  onChange={(event) => {
                                    field.onChange(event.target.value);
                                    form.setValue("ward", "", { shouldDirty: false, shouldValidate: step >= 1 });
                                    form.clearErrors("ward");
                                  }}
                                  aria-invalid={fieldState.invalid}
                                />
                              </FormControl>
                              <FormDescription>{urbanBodyConfig.description}</FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                      <FormField
                        control={form.control}
                        name="ward"
                        render={({ field, fieldState }) => (
                          <FormItem>
                            <FormLabel>Ward / Zone (optional)</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="Ward number or zone"
                                data-testid="input-ward-manual"
                                value={field.value ?? ""}
                                onChange={(event) => field.onChange(event.target.value)}
                                aria-invalid={fieldState.invalid}
                              />
                            </FormControl>
                            <FormDescription>Provide the ward or zone if assigned by the urban body.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
              </div>
                  )}

                  <FormField
                    control={form.control}
                    name="address"
                    rules={{ required: "Address is required" }}
                    render={({ field, fieldState }) => (
                      <FormItem>
                        <FormLabel>
                          House/Building Number, Street & Locality <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
          <Textarea 
            placeholder="e.g., House No. 123, Main Road, Near Post Office" 
            className={`min-h-20 ${fieldState.invalid ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            data-testid="input-address"
                            aria-invalid={fieldState.invalid}
                            {...field} 
                          />
                        </FormControl>
                        <FormDescription>Specific address details with landmarks</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="pincode"
                    rules={{
                      required: "PIN code is required",
                      validate: (value) => (/^[1-9]\d{5}$/.test(value) ? true : "Enter a valid 6-digit PIN code"),
                    }}
                    render={({ field, fieldState }) => (
                      <FormItem>
                        <FormLabel>
                          PIN Code <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-md border bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
                              {PINCODE_PREFIX}-
                            </span>
                            <Input
                              placeholder="Last 4 digits"
                              data-testid="input-pincode"
                              aria-invalid={fieldState.invalid}
                              className={`bg-muted/60 ${
                                showPincodeHint ? "border-amber-500 focus-visible:ring-amber-500 ring-offset-background" : ""
                              }`}
                              value={pincodeSuffixValue}
                              onChange={(event) => {
                                const suffix = sanitizePincodeSuffix(event.target.value);
                                field.onChange((PINCODE_PREFIX + suffix).slice(0, 6));
                              }}
                              onBlur={(event) => {
                                const suffix = sanitizePincodeSuffix(event.target.value);
                                field.onChange((PINCODE_PREFIX + suffix).slice(0, 6));
                                field.onBlur();
                              }}
                            />
                          </div>
                        </FormControl>
                        <p className="text-xs text-muted-foreground mt-1">
                          Prefix <span className="font-semibold">{PINCODE_PREFIX}</span> is fixed—enter the last 4 digits of your PIN code.
                        </p>
                        {showPincodeHint && (
                          <p className="text-xs text-amber-600 mt-1">Enter all remaining digits to continue.</p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="telephone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Telephone (Optional)</FormLabel>
                          <FormControl>
                            <Input placeholder="Landline number" data-testid="input-telephone" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                  </div>
                  </fieldset>
                </CardContent>
              </Card>
            )}

            {step === 2 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2 mb-2">
                    <UserIcon className="w-5 h-5 text-primary" />
                    <CardTitle>Owner Information</CardTitle>
                  </div>
                  <CardDescription>Details of the property owner</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Alert className="bg-muted/60 border-dashed border-muted">
                    <Info className="h-4 w-4" />
                    <AlertTitle>Profile-managed details</AlertTitle>
                    <AlertDescription className="flex flex-wrap items-center gap-2">
                      Name, contact and Aadhaar information come from your verified profile. Update them via
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-3"
                        onClick={goToProfile}
                      >
                        My Profile
                      </Button>
                      before starting the application.
                    </AlertDescription>
                  </Alert>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="ownerFirstName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            First Name <span className="text-destructive">*</span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              ref={field.ref}
                              name={field.name}
                              value={field.value ?? ""}
                              readOnly
                              aria-readonly="true"
                              placeholder="First name"
                              autoComplete="given-name"
                              autoCapitalize="words"
                              data-testid="input-owner-first-name"
                              className="bg-muted cursor-not-allowed"
                            />
                          </FormControl>
                          {renderProfileManagedDescription("First name")}
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="ownerLastName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Last Name <span className="text-destructive">*</span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              ref={field.ref}
                              name={field.name}
                              value={field.value ?? ""}
                              readOnly
                              aria-readonly="true"
                              placeholder="Last name"
                              autoComplete="family-name"
                              autoCapitalize="words"
                              data-testid="input-owner-last-name"
                              className="bg-muted cursor-not-allowed"
                            />
                          </FormControl>
                          {renderProfileManagedDescription("Last name")}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="ownerName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Owner Full Name (auto-filled)</FormLabel>
                        <FormControl>
                          <Input
                            ref={field.ref}
                            name={field.name}
                            value={field.value ?? ""}
                            readOnly
                            data-testid="input-owner-name"
                            className="bg-muted cursor-not-allowed"
                          />
                        </FormControl>
                        <FormDescription>Generated from first and last name for application records.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="ownerGender"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gender (affects registration fee)</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-owner-gender">
                                <SelectValue placeholder="Select gender" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {GENDER_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormDescription>Female owners receive an additional 5% fee discount</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="ownerMobile"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Mobile Number <span className="text-destructive">*</span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              ref={field.ref}
                              name={field.name}
                              value={field.value ?? ""}
                              readOnly
                              aria-readonly="true"
                              placeholder="10-digit mobile"
                              autoComplete="tel"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={10}
                              data-testid="input-owner-mobile"
                              className="bg-muted cursor-not-allowed"
                            />
                          </FormControl>
                          {renderProfileManagedDescription("Mobile number")}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="ownerEmail"
                      render={({ field }) => (
                        <FormItem>
                            <FormLabel>
                              Email <span className="text-destructive">*</span>
                            </FormLabel>
                            <FormControl>
                              <Input
                                ref={field.ref}
                                name={field.name}
                                type="email"
                                value={field.value ?? ""}
                                readOnly
                                aria-readonly="true"
                                placeholder="your@email.com"
                                data-testid="input-owner-email"
                                className="bg-muted cursor-not-allowed"
                              />
                            </FormControl>
                          {renderProfileManagedDescription("Email")}
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="ownerAadhaar"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Aadhaar Number <span className="text-destructive">*</span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              ref={field.ref}
                              name={field.name}
                              value={field.value ?? ""}
                              readOnly
                              aria-readonly="true"
                              placeholder="12-digit Aadhaar"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={12}
                              data-testid="input-owner-aadhaar"
                              className="bg-muted cursor-not-allowed"
                            />
                          </FormControl>
                          {renderProfileManagedDescription("Aadhaar number")}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="propertyOwnership"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Property Ownership <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <RadioGroup
                            onValueChange={field.onChange}
                            value={field.value}
                            className="flex gap-4"
                            data-testid="radio-property-ownership"
                          >
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="owned" id="owned" data-testid="radio-ownership-owned" />
                              <label htmlFor="owned" className="text-sm font-medium cursor-pointer">
                                Owned
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="leased" id="leased" data-testid="radio-ownership-leased" />
                              <label htmlFor="leased" className="text-sm font-medium cursor-pointer">
                                {OWNERSHIP_LABELS.leased}
                              </label>
                            </div>
                          </RadioGroup>
                        </FormControl>
                        <FormDescription>
                          Specify whether you own the property or have it on lease
                        </FormDescription>
                        {propertyOwnership === "leased" && (
                          <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-4 mt-3" data-testid="alert-lease-not-allowed">
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="w-5 h-5 text-orange-600 dark:text-orange-500 mt-0.5" />
                              <div className="space-y-1">
                                <p className="font-medium text-sm text-orange-700 dark:text-orange-200">
                                  Lease Deed Applications Not Accepted
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  The tourism department currently processes homestay registrations only for properties under clear ownership. Applications submitted on lease or sale deeds are not entertained.
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Please proceed with an owned property to continue your registration.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Discount Preview for Female Owners */}
                  {ownerGender === "female" && (
                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 mt-4" data-testid="alert-female-discount">
                      <div className="flex items-start gap-2">
                        <Sparkles className="w-5 h-5 text-green-600 dark:text-green-500 mt-0.5" />
                        <div className="flex-1">
                          <p className="font-medium text-sm text-green-600 dark:text-green-500">Special Discount Eligible!</p>
                          <p className="text-sm text-muted-foreground mt-1">
                            As a female property owner, you qualify for an additional <strong>5% discount</strong> on registration fees.
                          </p>
                          <p className="text-xs text-muted-foreground mt-2">
                            This discount will be automatically applied to your final fee calculation.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

{step === 3 && (
              <>
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Bed className="w-5 h-5 text-primary" />
                    <CardTitle>Rooms & Category</CardTitle>
                  </div>
                  <CardDescription>Number of rooms and property category</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="bg-muted/50 p-4 rounded-lg grid gap-4 md:grid-cols-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Total Rooms Configured</p>
                        <p className="text-2xl font-semibold">{totalRooms}</p>
                        <p className="text-xs text-muted-foreground mt-1">Limit: {MAX_ROOMS_ALLOWED} rooms</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Total Beds Planned</p>
                        <p className="text-2xl font-semibold">{totalBeds}</p>
                        <p className="text-xs text-muted-foreground mt-1">Limit: {MAX_BEDS_ALLOWED} beds</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Highest Tariff Range</p>
                        <p className="text-sm font-semibold">
                          {highestTariffLabel}
                        </p>
                        {highestRoomRate <= 0 && (
                          <p className="text-xs text-muted-foreground mt-1">No rooms configured yet</p>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {CATEGORY_CARD_INFO.map((card) => {
                        const selected = category === card.value;
                        const band = categoryRateBands[card.value] ?? DEFAULT_CATEGORY_RATE_BANDS[card.value];
                        const rangeLabel = formatBandLabel(band);
                        return (
                          <div
                            key={card.value}
                            className={`rounded-lg border p-4 transition ${selected ? "border-primary bg-primary/5" : "border-border"}`}
                            onClick={() => form.setValue("category", card.value)}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <Badge variant={getCategoryBadge(card.value).variant}>{card.title}</Badge>
                              {selected && <span className="text-xs font-semibold text-primary">Selected</span>}
                            </div>
                            <p className="text-sm font-medium">{rangeLabel}</p>
                            <p className="text-xs text-muted-foreground mt-2">{card.description}</p>
                          </div>
                        );
                      })}
                    </div>

                    <div className="rounded-lg border border-muted p-4 space-y-2 bg-muted/30">
                      <FormLabel className="text-xs uppercase text-muted-foreground">Room configuration mode</FormLabel>
                      <p className="text-sm font-semibold">
                        {roomCalcMode === "direct" ? "Option 2 · Actual nightly rent" : "Option 1 · Guided tariff buckets"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        This option is fixed by the Admin console so every applicant quotes tariffs the same way.
                      </p>
                    </div>

                    {type2CategoryConflict && (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>
                          {roomCalcMode === "direct"
                            ? "Tariff outside selected category"
                            : "Category conflict detected"}
                        </AlertTitle>
                        <AlertDescription>
                          {roomCalcMode === "direct"
                            ? "One or more actual nightly rents fall outside this category’s allowed band. Update the rent values or switch to a higher category."
                            : "One or more room types have tariffs above the selected category’s permitted range. Please switch the category or adjust the tariff buckets below to stay compliant with HP Homestay Rules 2025."}
                        </AlertDescription>
                      </Alert>
                    )}
                    {categoryWarnings.length ? (
                      <Alert className="border-amber-300 bg-amber-50 text-amber-900">
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                        <AlertTitle>Category exceeds published tariff</AlertTitle>
                        <AlertDescription className="space-y-1">
                          {categoryWarnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                          ))}
                          {lockToRecommendedCategory && (
                            <p className="text-xs text-amber-800">
                              Admin policy requires aligning with the recommended category
                              {suggestedCategory ? ` (${getCategoryBadge(suggestedCategory).label})` : ""} before continuing.
                            </p>
                          )}
                        </AlertDescription>
                      </Alert>
                    ) : null}

                    {type2Rows.length === 0 ? (
                      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                        No room configurations yet. Use “Add room type” to begin{" "}
                        {roomCalcMode === "direct" ? "and enter the actual nightly rent for each room." : "by selecting the tariff bucket."}
                      </div>
                    ) : (
                    <div className="space-y-4">
                      {type2Rows.map((row, index) => {
                        const availableTypeOptions = ROOM_TYPE_OPTIONS.filter(
                          (option) =>
                            option.value === row.roomType ||
                            !type2Rows.some((other) => other.roomType === option.value && other.id !== row.id),
                        );

                        const bucketInfo = TARIFF_BUCKETS.find((bucket) => bucket.value === row.tariffBucket);
                        const rowCategoryConflict =
                          bucketInfo ? CATEGORY_ORDER[resolvedCategory] < CATEGORY_ORDER[bucketInfo.minCategory] : false;
                        const rowCategoryOverkill =
                          bucketInfo && shouldLockCategoryWarning
                            ? CATEGORY_ORDER[resolvedCategory] > CATEGORY_ORDER[bucketInfo.minCategory]
                            : false;
                        const directRateValue =
                          typeof row.customRate === "number"
                            ? row.customRate
                            : row.customRate === "" || row.customRate === undefined
                              ? ""
                              : Number(row.customRate);
                        const directRateNumber =
                          typeof directRateValue === "number" && Number.isFinite(directRateValue) ? directRateValue : 0;
                        const directStatus = evaluateBandStatus(directRateNumber, resolvedCategoryBand);
                        const rowHighlightVariant =
                          roomCalcMode === "direct"
                            ? directStatus === "above"
                              ? "error"
                              : directStatus === "below"
                                ? "warning"
                                : "none"
                            : rowCategoryConflict
                              ? "error"
                              : rowCategoryOverkill
                                ? "warning"
                                : "none";
                        const tariffHighlightClass =
                          rowHighlightVariant === "error"
                            ? "border-destructive focus-visible:ring-destructive ring-offset-background"
                            : rowHighlightVariant === "warning"
                              ? "border-amber-500 focus-visible:ring-amber-500 ring-offset-background"
                              : undefined;
                        const tariffHelperText =
                          rowHighlightVariant === "error"
                            ? "This tariff exceeds the selected category's limit."
                            : rowHighlightVariant === "warning"
                              ? "Tariff fits a lower category. Consider switching to reduce the fee."
                              : null;
                        const directHelperText =
                          roomCalcMode === "direct"
                            ? directStatus === "above"
                              ? "Exceeds this category’s upper band. Reduce the rate or upgrade the category."
                              : directStatus === "below"
                                ? "Below the minimum for this category. Consider lowering the category or increasing the tariff."
                                : null
                            : null;
                        const containerHighlight =
                          roomCalcMode === "direct"
                            ? rowHighlightVariant === "error"
                              ? "border-destructive/60 bg-red-50"
                              : rowHighlightVariant === "warning"
                                ? "border-amber-400 bg-amber-50"
                                : "border-sky-200 bg-sky-50"
                            : "border-border bg-background";
                        const directInputHighlight =
                          rowHighlightVariant === "error"
                            ? "border-destructive focus-visible:ring-destructive ring-offset-background"
                            : rowHighlightVariant === "warning"
                              ? "border-amber-500 focus-visible:ring-amber-500 ring-offset-background"
                              : undefined;
                        const isDirectRateEmpty =
                          roomCalcMode === "direct" &&
                          (row.customRate === "" || row.customRate === undefined || directRateNumber <= 0);
                        const directPlaceholderClasses = isDirectRateEmpty
                          ? "text-muted-foreground/80 placeholder:text-muted-foreground/60 italic border-dashed border-amber-300 bg-amber-50/50 focus:text-foreground"
                          : "";
                        return (
                          <div key={row.id} className={`rounded-xl p-4 space-y-3 border ${containerHighlight}`}>
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-medium">
                                Room Configuration {type2Rows.length > 1 ? `#${index + 1}` : ""}
                              </p>
                              {type2Rows.length > 1 && (
                                <Button variant="ghost" size="sm" onClick={() => removeType2Row(row.id)}>
                                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              )}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                              {(() => {
                                const { rooms: roomsUsedElsewhere, beds: bedsUsedElsewhere } = summarizeRows(type2Rows, row.id);
                                const roomsAvailable = Math.max(0, MAX_ROOMS_ALLOWED - roomsUsedElsewhere);
                                const bedsAvailable = Math.max(0, MAX_BEDS_ALLOWED - bedsUsedElsewhere);
                                const quantityOptions =
                                  roomsAvailable > 0
                                    ? Array.from({ length: roomsAvailable }, (_, idx) => idx + 1)
                                    : row.quantity > 0
                                      ? [row.quantity]
                                      : [1];
                                const effectiveQuantity = row.quantity || 1;
                                const rawMaxBeds =
                                  effectiveQuantity > 0
                                    ? Math.floor(bedsAvailable / effectiveQuantity)
                                    : bedsAvailable || MAX_BEDS_PER_ROOM;
                                const maxBedsOption = Math.max(1, Math.min(MAX_BEDS_PER_ROOM, rawMaxBeds));
                                const bedOptions = Array.from({ length: maxBedsOption }, (_, idx) => idx + 1);
                                const bedsPerRoom = getRowBedsPerRoom(row);
                                const roomsRemaining = Math.max(
                                  0,
                                  MAX_ROOMS_ALLOWED - (roomsUsedElsewhere + effectiveQuantity),
                                );
                                const bedsRemaining = Math.max(
                                  0,
                                  MAX_BEDS_ALLOWED - (bedsUsedElsewhere + effectiveQuantity * bedsPerRoom),
                                );

                                return (
                                  <>
                                    <div>
                                      <FormLabel className="text-xs uppercase text-muted-foreground">Room Type</FormLabel>
                                      <Select
                                        value={row.roomType}
                                        onValueChange={(value) => updateType2Row(row.id, { roomType: value as RoomTypeOption })}
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="Select type" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {availableTypeOptions.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                              {option.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    <div>
                                      <FormLabel className="text-xs uppercase text-muted-foreground">Qty (rooms)</FormLabel>
                                      <Select
                                        value={String(row.quantity || 1)}
                                        onValueChange={(value) => updateType2Row(row.id, { quantity: Number(value) })}
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="1" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {quantityOptions.map((qty) => (
                                            <SelectItem key={qty} value={String(qty)}>
                                              {qty}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <p className="text-[11px] text-muted-foreground mt-1">
                                        {roomsRemaining} rooms remaining
                                      </p>
                                    </div>
                                    <div>
                                      <FormLabel className="text-xs uppercase text-muted-foreground">Beds per room</FormLabel>
                                      <Select
                                        value={String(bedsPerRoom)}
                                        onValueChange={(value) => updateType2Row(row.id, { bedsPerRoom: Number(value) })}
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="Beds" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {bedOptions.map((bedsOption) => (
                                            <SelectItem key={bedsOption} value={String(bedsOption)}>
                                              {bedsOption}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <p className="text-[11px] text-muted-foreground mt-1">
                                        {bedsRemaining} beds remaining
                                      </p>
                                    </div>
                                    <div>
                                      <FormLabel className="text-xs uppercase text-muted-foreground">Tariff Range</FormLabel>
                                      {roomCalcMode === "direct" ? (
                                        <>
                                          <Input
                                            type="number"
                                            min={resolvedCategoryBand.min}
                                            max={resolvedCategoryBand.max ?? undefined}
                                            step="100"
                                            value={directRateValue === "" ? "" : directRateValue}
                                            className={`${directInputHighlight ?? ""} ${directPlaceholderClasses}`}
                                            placeholder="e.g. 4500"
                                            onChange={(event) =>
                                              updateType2Row(row.id, {
                                                customRate:
                                                  event.target.value === "" ? "" : Number(event.target.value),
                                              })
                                            }
                                          />
                                          <p className="text-[11px] text-muted-foreground mt-1">
                                            Allowed band: {formatBandLabel(resolvedCategoryBand)}
                                          </p>
                                          {directHelperText && (
                                            <p
                                              className={`text-[11px] mt-1 ${
                                                rowHighlightVariant === "error" ? "text-destructive" : "text-amber-600"
                                              }`}
                                            >
                                              {directHelperText}
                                            </p>
                                          )}
                                        </>
                                      ) : (
                                        <>
                                          <Select
                                            value={row.tariffBucket}
                                            onValueChange={(value) =>
                                              updateType2Row(row.id, { tariffBucket: value as TariffBucket })
                                            }
                                          >
                                            <SelectTrigger
                                              className={`${tariffHighlightClass ?? ""} whitespace-normal font-medium`}
                                            >
                                              <SelectValue placeholder="Select tariff" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              {TARIFF_BUCKETS.map((bucket) => (
                                                <SelectItem key={bucket.value} value={bucket.value}>
                                                  {bucket.label}
                                                </SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                          {bucketInfo && (
                                            <p className="text-[11px] text-muted-foreground mt-1">
                                              {bucketInfo.label} · {bucketInfo.explanation}
                                            </p>
                                          )}
                                          {tariffHelperText && (
                                            <p
                                              className={`text-[11px] mt-1 ${
                                                rowHighlightVariant === "error" ? "text-destructive" : "text-amber-600"
                                              }`}
                                            >
                                              {tariffHelperText}
                                            </p>
                                          )}
                                        </>
                                      )}
                                    </div>
                                    <div>
                                      <FormLabel className="text-xs uppercase text-muted-foreground">Average Area (sq.m.)</FormLabel>
                                      <Input
                                        type="number"
                                        min={0}
                                        step="0.5"
                                        value={row.area === "" ? "" : row.area ?? ""}
                                        placeholder="e.g. 18"
                                        onChange={(event) =>
                                          updateType2Row(row.id, {
                                            area: event.target.value === "" ? "" : Number(event.target.value),
                                          })
                                        }
                                      />
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    )}

                    <div className="flex flex-wrap gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={addType2Row}
                        className="w-full md:w-auto"
                        disabled={type2Rows.length >= ROOM_TYPE_OPTIONS.length}
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add another room type
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={resetType2Rows}
                        className="w-full md:w-auto"
                      >
                        Clear all
                      </Button>
                    </div>

                    <div className="rounded-lg border p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={syncAttachedBaths}
                          onCheckedChange={(checked) => {
                            const nextValue = checked === true;
                            setSyncAttachedBaths(nextValue);
                            if (nextValue) {
                              form.setValue("attachedWashrooms", totalRooms, { shouldDirty: true });
                            }
                          }}
                        />
                        <div>
                          <p className="font-medium text-sm">Every room has an attached washroom</p>
                          <p className="text-xs text-muted-foreground">
                            Keep this on if all configured rooms include attached washrooms. Turn it off to enter a different count.
                          </p>
                        </div>
                      </div>
                      {!syncAttachedBaths && (
                        <FormField
                          control={form.control}
                          name="attachedWashrooms"
                          render={({ field }) => (
                            <FormItem className="mt-2">
                              <FormLabel>Total rooms with attached washrooms</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  min={0}
                                  max={Math.max(totalRooms, 0)}
                                  placeholder="Enter count"
                                  value={field.value ?? ""}
                                  onChange={(event) => field.onChange(clampInt(event.target.value))}
                                />
                              </FormControl>
                              <FormDescription>Must be at least equal to the number of rooms to proceed.</FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                    </div>

                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      Add up to three rows—one each for Single, Double, and Suite categories.{" "}
                      {roomCalcMode === "direct"
                        ? "Enter the exact nightly rent within the allowed band for the selected category."
                        : "Select the tariff bucket that matches your published rate."}{" "}
                      We’ll keep the running totals and highlight any category violations automatically.
                    </div>

                    {(category === "diamond" || category === "gold") && (
                      <FormField
                        control={form.control}
                        name="gstin"
                        rules={{
                          validate: (value) => {
                            const trimmed = sanitizeGstinInput(value ?? "");
                            if (!trimmed) {
                              return "GSTIN is required for Diamond and Gold category properties";
                            }
                            if (trimmed.length !== 15) {
                              return "GSTIN must be exactly 15 characters";
                            }
                            if (!/^[0-9A-Z]{15}$/.test(trimmed)) {
                              return "GSTIN can contain only numbers and capital letters";
                            }
                            return true;
                          },
                        }}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>GSTIN (mandatory for Gold/Diamond)</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                placeholder="15-character GSTIN"
                                data-testid="input-gstin"
                                maxLength={15}
                                value={field.value ?? ""}
                                onChange={(event) => field.onChange(sanitizeGstinInput(event.target.value))}
                              />
                            </FormControl>
                            <FormDescription>GST registration is mandatory for Diamond and Gold categories</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Video className="w-5 h-5 text-primary" />
                    <CardTitle>Mandatory Safety Checklist</CardTitle>
                  </div>
                  <CardDescription>
                    Confirm these baseline safety requirements before inspections.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    CCTV coverage and fire-safety equipment (extinguishers, alarms, emergency exits) must be installed and working before your site inspection. Check both boxes to acknowledge compliance.
                  </p>
                  <div className="grid md:grid-cols-2 gap-3">
                    {["cctv", "fireSafety"].map((id) => {
                      const amenity = AMENITIES.find((a) => a.id === id)!;
                      const IconComponent = amenity.icon;
                      return (
                        <label
                          key={id}
                          className="flex items-start gap-3 border rounded-lg p-3 bg-muted/30 cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedAmenities[id] || false}
                            onCheckedChange={(checked) =>
                              setSelectedAmenities((prev) => ({
                                ...prev,
                                [id]: !!checked,
                              }))
                            }
                          />
                          <div>
                            <p className="font-medium flex items-center gap-2">
                              <IconComponent className="w-4 h-4 text-primary" />
                              {amenity.label}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Required before approval and inspection.
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  {(!selectedAmenities.cctv || !selectedAmenities.fireSafety) && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        Please confirm both CCTV and fire-safety measures to proceed.
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
              </>
            )}

            {step === 4 && (
              <Card>
                <CardHeader>
                  <CardTitle>Distances & Public Areas</CardTitle>
                  <CardDescription>Location details and common areas (all fields optional)</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      Distances are auto-filled based on your district. You can modify them if your property is in a different location.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <h4 className="font-medium">Distances from Key Locations (in km)</h4>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="distanceAirport"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Airport</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                placeholder="Distance in KM" 
                                data-testid="input-distance-airport" 
                                min={0}
                                step="any"
                                inputMode="decimal"
                                pattern="^\\d*(\\.\\d*)?$"
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(normalizeOptionalFloat(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="distanceRailway"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Railway Station</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                placeholder="Distance in KM" 
                                data-testid="input-distance-railway" 
                                min={0}
                                step="any"
                                inputMode="decimal"
                                pattern="^\\d*(\\.\\d*)?$"
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(normalizeOptionalFloat(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="distanceCityCenter"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>City Centre</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                placeholder="Distance in KM" 
                                data-testid="input-distance-city-center" 
                                min={0}
                                step="any"
                                inputMode="decimal"
                                pattern="^\\d*(\\.\\d*)?$"
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(normalizeOptionalFloat(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="distanceShopping"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Shopping Centre</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                placeholder="Distance in KM" 
                                data-testid="input-distance-shopping" 
                                min={0}
                                step="any"
                                inputMode="decimal"
                                pattern="^\\d*(\\.\\d*)?$"
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(normalizeOptionalFloat(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="distanceBusStand"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Bus Stand</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                placeholder="Distance in KM" 
                                data-testid="input-distance-bus-stand" 
                                min={0}
                                step="any"
                                inputMode="decimal"
                                pattern="^\\d*(\\.\\d*)?$"
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(normalizeOptionalFloat(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  <div className="space-y-4 border-t pt-4">
                    <h4 className="font-medium">Public Areas</h4>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="lobbyArea"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Lobby/Lounge Area (sq ft)</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                placeholder="Optional"
                                data-testid="input-lobby-area"
                                min={0}
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(normalizeOptionalFloat(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="diningArea"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Dining Space (sq ft)</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                placeholder="Optional"
                                data-testid="input-dining-area"
                                min={0}
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(normalizeOptionalFloat(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="parkingArea"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Parking Facilities</FormLabel>
                          <FormControl>
                            <Textarea 
                              placeholder="Describe parking facilities (e.g., covered parking for 5 cars)" 
                              className="min-h-20"
                              data-testid="input-parking-area" 
                              {...field} 
                            />
                          </FormControl>
                          <FormDescription>Optional - describe available parking</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {step === 5 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-5 h-5 text-primary" />
                    <CardTitle>Upload Documents (ANNEXURE-II)</CardTitle>
                  </div>
                  <CardDescription>Upload required documents as per 2025 Homestay Rules</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Revenue Papers (Jamabandi & Tatima) */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Revenue Papers (Jamabandi & Tatima) <span className="text-destructive">*</span>
                    </label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Land revenue records showing ownership
                    </p>
                    <ObjectUploader
                      label="Upload Revenue Papers"
                      maxFiles={2}
                      fileType="revenue-papers"
                      onUploadComplete={(paths) => setUploadedDocuments(prev => ({ ...prev, revenuePapers: paths }))}
                      existingFiles={uploadedDocuments.revenuePapers}
                    />
                  </div>

                  {/* Affidavit under Section 29 */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Affidavit under Section 29 <span className="text-destructive">*</span>
                    </label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Sworn statement as per homestay regulations
                    </p>
                    <ObjectUploader
                      label="Upload Affidavit"
                      maxFiles={1}
                      fileType="affidavit-section29"
                      onUploadComplete={(paths) => setUploadedDocuments(prev => ({ ...prev, affidavitSection29: paths }))}
                      existingFiles={uploadedDocuments.affidavitSection29}
                    />
                  </div>

                  {/* Undertaking in Form-C */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Undertaking in Form-C <span className="text-destructive">*</span>
                    </label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Signed undertaking form as per prescribed format
                    </p>
                    <ObjectUploader
                      label="Upload Form-C"
                      maxFiles={1}
                      fileType="undertaking-form-c"
                      onUploadComplete={(paths) => setUploadedDocuments(prev => ({ ...prev, undertakingFormC: paths }))}
                      existingFiles={uploadedDocuments.undertakingFormC}
                    />
                  </div>

                  {requiresCommercialUtilityProof && (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Proof of Commercial Electricity Bill <span className="text-destructive">*</span>
                        </label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Upload the latest electricity bill that shows the commercial tariff for this property
                        </p>
                        <ObjectUploader
                          label="Upload Electricity Bill"
                          maxFiles={1}
                          fileType="commercial-electricity-bill"
                          onUploadComplete={(paths) =>
                            setUploadedDocuments((prev) => ({ ...prev, commercialElectricityBill: paths }))
                          }
                          existingFiles={uploadedDocuments.commercialElectricityBill}
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Proof of Commercial Water Bill <span className="text-destructive">*</span>
                        </label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Upload the commercial water connection bill for this homestay
                        </p>
                        <ObjectUploader
                          label="Upload Water Bill"
                          maxFiles={1}
                          fileType="commercial-water-bill"
                          onUploadComplete={(paths) =>
                            setUploadedDocuments((prev) => ({ ...prev, commercialWaterBill: paths }))
                          }
                          existingFiles={uploadedDocuments.commercialWaterBill}
                        />
                      </div>
                    </>
                  )}

                  {/* Property Photographs */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Property Photographs <span className="text-destructive">*</span> (Minimum 2 photos)
                    </label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Clear photos of property exterior, rooms, and facilities
                    </p>
                    <ObjectUploader
                      label="Upload Property Photos"
                      multiple={true}
                      maxFiles={10}
                      fileType="property-photo"
                      category="photos"
                      onUploadComplete={(paths) => setPropertyPhotos(paths)}
                      existingFiles={propertyPhotos}
                    />
                  </div>

                  {/* Validation Messages */}
                  {(() => {
                    const missingRevenue = uploadedDocuments.revenuePapers.length === 0;
                    const missingAffidavit = uploadedDocuments.affidavitSection29.length === 0;
                    const missingUndertaking = uploadedDocuments.undertakingFormC.length === 0;
                    const missingElectricity =
                      requiresCommercialUtilityProof && uploadedDocuments.commercialElectricityBill.length === 0;
                    const missingWater =
                      requiresCommercialUtilityProof && uploadedDocuments.commercialWaterBill.length === 0;
                    const missingPhotos = propertyPhotos.length < 2;
                    const showWarning =
                      missingRevenue ||
                      missingAffidavit ||
                      missingUndertaking ||
                      missingElectricity ||
                      missingWater ||
                      missingPhotos;
                    if (!showWarning) {
                      return null;
                    }
                    return (
                    <div className="bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4 mt-4">
                      <p className="text-sm text-orange-800 dark:text-orange-200 font-medium mb-2">Required documents missing:</p>
                      <ul className="text-sm text-orange-700 dark:text-orange-300 list-disc list-inside space-y-1">
                        {missingRevenue && <li>Revenue Papers (Jamabandi & Tatima)</li>}
                        {missingAffidavit && <li>Affidavit under Section 29</li>}
                        {missingUndertaking && <li>Undertaking in Form-C</li>}
                        {missingElectricity && <li>Proof of commercial electricity bill</li>}
                        {missingWater && <li>Proof of commercial water bill</li>}
                        {missingPhotos && <li>At least 2 property photos ({propertyPhotos.length}/2)</li>}
                      </ul>
                    </div>
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            {step === 6 && (
              <Card>
                <CardHeader>
                  <CardTitle>Amenities, Facilities & Fee Summary</CardTitle>
                  <CardDescription>Final details and registration fee calculation</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Amenities Section */}
                  <div className="space-y-4">
                    <h4 className="font-medium">Property Amenities</h4>
                    <p className="text-sm text-muted-foreground">
                      CCTV surveillance and fire-safety equipment remain locked because you confirmed them in the safety checklist. Other amenities are optional.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {AMENITIES.map((amenity) => {
                        const IconComponent = amenity.icon;
                        const isMandatory = MANDATORY_AMENITY_IDS.has(amenity.id);
                        const isChecked = selectedAmenities[amenity.id] || false;
                        return (
                          <div
                            key={amenity.id}
                            className={`flex items-center space-x-3 p-3 border rounded-lg hover-elevate ${isMandatory ? "opacity-90 border-dashed bg-muted/50 cursor-not-allowed" : ""}`}
                            data-testid={`checkbox-amenity-${amenity.id}`}
                          >
                            <Checkbox
                              checked={isChecked}
                              disabled={isMandatory}
                              onCheckedChange={(checked) => 
                                !isMandatory && setSelectedAmenities(prev => ({ ...prev, [amenity.id]: !!checked }))
                              }
                            />
                            <label 
                              className={`flex items-center gap-2 flex-1 ${isMandatory ? "cursor-not-allowed" : "cursor-pointer"}`}
                              onClick={() => {
                                if (isMandatory) return;
                                setSelectedAmenities(prev => ({ ...prev, [amenity.id]: !prev[amenity.id] }));
                              }}
                            >
                              <IconComponent className="w-4 h-4 text-primary" />
                              <span className="text-sm font-medium">{amenity.label}</span>
                              {isMandatory && (
                                <Badge variant="outline" className="text-[10px] uppercase ml-auto">
                                  Mandatory
                                </Badge>
                              )}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Additional Facilities Section */}
                  <div className="space-y-4 border-t pt-4">
                    <h4 className="font-medium">Additional Facilities (Optional)</h4>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="ecoFriendlyFacilities"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Eco-Friendly Facilities</FormLabel>
                            <FormControl>
                              <Textarea 
                                placeholder="Solar panels, rainwater harvesting, waste management, etc." 
                                className="min-h-20"
                                data-testid="input-eco-friendly" 
                                {...field} 
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="differentlyAbledFacilities"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Differently Abled Facilities</FormLabel>
                            <FormControl>
                              <Textarea 
                                placeholder="Ramps, wheelchair access, accessible washrooms, etc." 
                                className="min-h-20"
                                data-testid="input-differently-abled" 
                                {...field} 
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="fireEquipmentDetails"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Fire Safety Equipment</FormLabel>
                            <FormControl>
                              <Textarea 
                                placeholder="Fire extinguishers, smoke detectors, emergency exits, etc." 
                                className="min-h-20"
                                data-testid="input-fire-equipment" 
                                {...field} 
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="nearestHospital"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Nearest Hospital</FormLabel>
                            <FormControl>
                              <Input 
                                placeholder="Name and distance" 
                                data-testid="input-nearest-hospital" 
                                {...field} 
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  {/* Certificate Validity Selection */}
                  <div className="border-t pt-6">
                    <h4 className="font-medium mb-4">Certificate Validity Period</h4>
                    <FormField
                      control={form.control}
                      name="certificateValidityYears"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <RadioGroup
                              onValueChange={field.onChange}
                              value={field.value}
                              className="grid grid-cols-1 md:grid-cols-2 gap-4"
                            >
                              <div className={`flex items-start space-x-3 p-4 border-2 rounded-lg cursor-pointer transition-all hover-elevate ${field.value === "1" ? "border-primary bg-primary/5" : "border-border"}`}>
                                <RadioGroupItem value="1" id="validity-1" className="mt-1" />
                                <label htmlFor="validity-1" className="flex-1 cursor-pointer">
                                  <div className="font-medium mb-1">1 Year (Standard)</div>
                                  <div className="text-sm text-muted-foreground">
                                    Annual fee: ₹{fees.baseFee.toFixed(0)}
                                  </div>
                                </label>
                              </div>
                              <div className={`flex items-start space-x-3 p-4 border-2 rounded-lg cursor-pointer transition-all hover-elevate ${field.value === "3" ? "border-primary bg-primary/5" : "border-border"}`}>
                                <RadioGroupItem value="3" id="validity-3" className="mt-1" />
                                <label htmlFor="validity-3" className="flex-1 cursor-pointer">
                                  <div className="font-medium mb-1 flex items-center gap-2">
                                    3 Years (Lump Sum)
                                    <Badge variant="default" className="text-xs">10% OFF</Badge>
                                  </div>
                                  <div className="text-sm text-muted-foreground">
                                    Save ₹{((fees.baseFee * 3 * 0.10)).toFixed(0)} with 3-year payment
                                  </div>
                                </label>
                              </div>
                            </RadioGroup>
                          </FormControl>
                          <FormDescription>
                            Choose certificate validity period. 3-year lump sum payment receives 10% discount
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* Fee Summary Section */}
                  <div className="border-t pt-6">
                    <h4 className="font-medium mb-4">Registration Fee Summary</h4>
                    <div className="bg-primary/5 p-6 rounded-lg border-2 border-primary/20">
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Category</span>
                        <Badge variant={getCategoryBadge(category).variant}>
                          {getCategoryBadge(category).label}
                        </Badge>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Location Type</span>
                        <span className="font-medium text-sm">{LOCATION_LABEL_MAP[locationType] || "—"}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Certificate Validity</span>
                        <span className="font-medium">{certificateValidityYears} {certificateValidityYears === "1" ? "year" : "years"}</span>
                      </div>
                      <div className="border-t pt-3 mt-3">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Base Fee (Annual)</span>
                          <span className="font-medium">₹{fees.baseFee.toFixed(0)}</span>
                        </div>
                        {certificateValidityYears === "3" && (
                          <div className="flex justify-between mt-2">
                            <span className="text-muted-foreground">Total ({certificateValidityYears} years)</span>
                            <span className="font-medium">₹{(fees.baseFee * 3).toFixed(0)}</span>
                          </div>
                        )}
                      </div>
                      {(fees.validityDiscount > 0 || fees.femaleOwnerDiscount > 0 || fees.pangiDiscount > 0) && (
                        <div className="border-t pt-3 mt-3">
                          <div className="text-sm font-medium mb-2 text-green-600 dark:text-green-400">Discounts Applied:</div>
                          {fees.validityDiscount > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">3-year lump sum (10%)</span>
                              <span className="text-green-600 dark:text-green-400">-₹{fees.validityDiscount.toFixed(0)}</span>
                            </div>
                          )}
                          {fees.femaleOwnerDiscount > 0 && (
                            <div className="flex justify-between text-sm mt-1">
                              <span className="text-muted-foreground">Female owner (5%)</span>
                              <span className="text-green-600 dark:text-green-400">-₹{fees.femaleOwnerDiscount.toFixed(0)}</span>
                            </div>
                          )}
                          {fees.pangiDiscount > 0 && (
                            <div className="flex justify-between text-sm mt-1">
                              <span className="text-muted-foreground">Pangi sub-division (50%)</span>
                              <span className="text-green-600 dark:text-green-400">-₹{fees.pangiDiscount.toFixed(0)}</span>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="pt-3 border-t flex justify-between text-lg">
                        <span className="font-semibold">Total Payable</span>
                        <span className="font-bold text-primary" data-testid="text-total-fee">₹{fees.totalFee.toFixed(0)}</span>
                      </div>
                      {fees.savingsAmount > 0 && (
                        <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-lg p-3 mt-3">
                          <p className="text-sm text-green-800 dark:text-green-200 font-medium">
                            ✨ You save ₹{fees.savingsAmount.toFixed(0)} ({fees.savingsPercentage.toFixed(1)}%)
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <ApplicationSummaryCard
                    className="bg-muted/50 border-0 shadow-none"
                    highlightCategoryBadge={false}
                    application={{
                      applicationNumber: activeDraftApplication?.applicationNumber ?? correctionId ?? undefined,
                      propertyName: form.watch("propertyName") || undefined,
                      address: form.watch("address") || undefined,
                      district: form.watch("district") || undefined,
                      tehsil: form.watch("tehsil") || undefined,
                      tehsilOther: form.watch("tehsilOther") || undefined,
                      pincode: form.watch("pincode") || undefined,
                      ownerName: form.watch("ownerName") || undefined,
                      ownerMobile: form.watch("ownerMobile") || undefined,
                      totalRooms,
                      category: form.watch("category") || undefined,
                    }}
                    owner={{
                      name: form.watch("ownerName"),
                      mobile: form.watch("ownerMobile"),
                      email: form.watch("ownerEmail"),
                    }}
                    extraRows={[
                      { label: "Amenities", value: `${selectedAmenitiesCount} selected` },
                    ]}
                  />
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex flex-wrap justify-between gap-4">
              {step > 1 && (
                <Button type="button" variant="outline" onClick={prevStep} data-testid="button-previous">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Previous
                </Button>
              )}

              <div className="flex-1" />

              {/* Save Draft button - only for new applications */}
              {!isCorrectionMode && (
                <Button 
                  type="button" 
                  variant="outline"
                  onClick={() => saveDraftMutation.mutate()}
                  disabled={saveDraftMutation.isPending}
                  data-testid="button-save-draft"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {saveDraftMutation.isPending ? "Saving..." : "Save Draft"}
                </Button>
              )}

              {/* Preview button - only on final page */}
              {step === totalSteps && (
                <Button 
                  type="button" 
                  variant="outline"
                  onClick={() => setShowPreview(true)}
                  data-testid="button-preview"
                >
                  <FileText className="w-4 h-4 mr-2" />
                  Preview
                </Button>
              )}

              {isCorrectionMode && step === totalSteps && (
                <div className="w-full rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20">
                  <div className="flex flex-col gap-2">
                    <p className="font-semibold">Final Confirmation</p>
                    <p>
                      I confirm that every issue highlighted by DA/DTDO has been fully addressed. I understand that my application may be rejected if the corrections remain unsatisfactory.
                    </p>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="correction-ack"
                        checked={correctionAcknowledged}
                        onCheckedChange={(checked) => setCorrectionAcknowledged(Boolean(checked))}
                      />
                      <label htmlFor="correction-ack" className="text-sm font-medium cursor-pointer">
                        I agree and want to resubmit the application
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {step < totalSteps ? (
                <Button 
                  type="button" 
                  onClick={(e) => {
                    e.preventDefault();
                    nextStep();
                  }} 
                  disabled={isNextDisabled}
                  data-testid="button-next"
                >
                  Next
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              ) : (
                <Button 
                  type="submit" 
                  disabled={submitApplicationMutation.isPending || (isCorrectionMode && !correctionAcknowledged)}
                  data-testid="button-submit-application"
                  onClick={async () => {
                    console.log("Submit button clicked");
                    const isValid = await form.trigger();
                    console.log("Form is valid:", isValid);
                    console.log("Form errors:", form.formState.errors);
                    
                    if (!isValid) {
                      toast({
                        title: "Form validation failed",
                        description: "Please check all fields are filled correctly.",
                        variant: "destructive",
                      });
                    }
                  }}
                >
                  <Send className="w-4 h-4 mr-2" />
                  {submitApplicationMutation.isPending ? "Submitting..." : submitButtonLabel}
                </Button>
              )}
            </div>
          </form>
        </Form>

        {/* Preview Dialog */}
        <Dialog open={showPreview} onOpenChange={setShowPreview}>
          <DialogContent className="max-w-4xl max-h-[90vh]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Eye className="w-5 h-5" />
                Application Preview
              </DialogTitle>
              <DialogDescription>
                Review all details before final submission
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="h-[calc(90vh-120px)] pr-4">
              <div className="space-y-6">
                {/* Page 1: Property Details */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Property Details</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4 text-sm">
                    <div><span className="text-muted-foreground">Property Name:</span> <span className="font-medium">{form.watch("propertyName") || "—"}</span></div>
                    <div><span className="text-muted-foreground">District:</span> <span className="font-medium">{form.watch("district") || "—"}</span></div>
                    <div><span className="text-muted-foreground">Tehsil:</span> <span className="font-medium">{displayTehsil}</span></div>
                    <div className="col-span-2"><span className="text-muted-foreground">Address:</span> <span className="font-medium">{form.watch("address") || "—"}</span></div>
                    <div><span className="text-muted-foreground">Pincode:</span> <span className="font-medium">{form.watch("pincode") || "—"}</span></div>
                    <div><span className="text-muted-foreground">Location Type:</span> <span className="font-medium">{LOCATION_TYPES.find(t => t.value === form.watch("locationType"))?.label || "—"}</span></div>
                    <div><span className="text-muted-foreground">Telephone:</span> <span className="font-medium">{form.watch("telephone") || "—"}</span></div>
                  </CardContent>
                </Card>

                {/* Page 2: Owner Information */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Owner Information</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4 text-sm">
                    <div><span className="text-muted-foreground">Owner Name:</span> <span className="font-medium">{form.watch("ownerName") || "—"}</span></div>
                    <div><span className="text-muted-foreground">Mobile:</span> <span className="font-medium">{form.watch("ownerMobile") || "—"}</span></div>
                    <div><span className="text-muted-foreground">Email:</span> <span className="font-medium">{form.watch("ownerEmail") || "—"}</span></div>
                    <div><span className="text-muted-foreground">Aadhaar:</span> <span className="font-medium">{form.watch("ownerAadhaar") || "—"}</span></div>
                    <div><span className="text-muted-foreground">Ownership Type:</span> <span className="font-medium">{propertyOwnership ? OWNERSHIP_LABELS[propertyOwnership] : "—"}</span></div>
                  </CardContent>
                </Card>

                {/* Page 3: Room Details & Category */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Room Details & Category</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4 text-sm">
                    <div><span className="text-muted-foreground">Category:</span> <Badge className="ml-2">{form.watch("category")?.toUpperCase() || "—"}</Badge></div>
                    <div><span className="text-muted-foreground">Room Rate:</span> <span className="font-medium">₹{form.watch("proposedRoomRate") || 0}/day</span></div>
                    <div><span className="text-muted-foreground">Project Type:</span> <span className="font-medium">{form.watch("projectType") === "new_project" ? "New Project" : "New Rooms"}</span></div>
                    <div><span className="text-muted-foreground">Property Area:</span> <span className="font-medium">{form.watch("propertyArea") || 0} sq m</span></div>
                    <div><span className="text-muted-foreground">Single Bed Rooms:</span> <span className="font-medium">{form.watch("singleBedRooms") || 0} (Beds/room: {singleBedBeds})</span></div>
                    <div><span className="text-muted-foreground">Double Bed Rooms:</span> <span className="font-medium">{form.watch("doubleBedRooms") || 0} (Beds/room: {doubleBedBeds})</span></div>
                    <div><span className="text-muted-foreground">Family Suites:</span> <span className="font-medium">{form.watch("familySuites") || 0} (Beds/room: {familySuiteBeds})</span></div>
                    <div><span className="text-muted-foreground">Total Rooms:</span> <span className="font-medium">{totalRooms}</span></div>
                    <div><span className="text-muted-foreground">Total Beds:</span> <span className="font-medium">{totalBeds}</span></div>
                    <div><span className="text-muted-foreground">Attached Washrooms:</span> <span className="font-medium">{form.watch("attachedWashrooms") || 0}</span></div>
                    <div><span className="text-muted-foreground">GSTIN:</span> <span className="font-medium">{form.watch("gstin") || "Not provided"}</span></div>
                  </CardContent>
                </Card>

                {/* Page 4: Distances & Public Areas */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Distances & Public Areas</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4 text-sm">
                    <div><span className="text-muted-foreground">Airport:</span> <span className="font-medium">{formatDistanceDisplay(form.watch("distanceAirport"))}</span></div>
                    <div><span className="text-muted-foreground">Railway Station:</span> <span className="font-medium">{formatDistanceDisplay(form.watch("distanceRailway"))}</span></div>
                    <div><span className="text-muted-foreground">City Center:</span> <span className="font-medium">{formatDistanceDisplay(form.watch("distanceCityCenter"))}</span></div>
                    <div><span className="text-muted-foreground">Shopping Area:</span> <span className="font-medium">{formatDistanceDisplay(form.watch("distanceShopping"))}</span></div>
                    <div><span className="text-muted-foreground">Bus Stand:</span> <span className="font-medium">{formatDistanceDisplay(form.watch("distanceBusStand"))}</span></div>
                    <div><span className="text-muted-foreground">Lobby Area:</span> <span className="font-medium">{form.watch("lobbyArea") || "—"} sq ft</span></div>
                    <div><span className="text-muted-foreground">Dining Area:</span> <span className="font-medium">{form.watch("diningArea") || "—"} sq ft</span></div>
                    <div className="col-span-2"><span className="text-muted-foreground">Parking:</span> <span className="font-medium">{form.watch("parkingArea") || "—"}</span></div>
                  </CardContent>
                </Card>

                {/* Page 5: Documents */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Uploaded Documents</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div><span className="text-muted-foreground">Revenue Papers:</span> <span className="font-medium">{uploadedDocuments.revenuePapers.length} file(s)</span></div>
                    <div><span className="text-muted-foreground">Affidavit Section 29:</span> <span className="font-medium">{uploadedDocuments.affidavitSection29.length} file(s)</span></div>
                    <div><span className="text-muted-foreground">Undertaking Form-C:</span> <span className="font-medium">{uploadedDocuments.undertakingFormC.length} file(s)</span></div>
                    {requiresCommercialUtilityProof && (
                      <>
                        <div><span className="text-muted-foreground">Commercial Electricity Bill:</span> <span className="font-medium">{uploadedDocuments.commercialElectricityBill.length} file(s)</span></div>
                        <div><span className="text-muted-foreground">Commercial Water Bill:</span> <span className="font-medium">{uploadedDocuments.commercialWaterBill.length} file(s)</span></div>
                      </>
                    )}
                    <div><span className="text-muted-foreground">Property Photos:</span> <span className="font-medium">{propertyPhotos.length} file(s)</span></div>
                  </CardContent>
                </Card>

                {/* Page 6: Amenities & Fees */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Amenities & Fee Summary</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">Selected Amenities:</p>
                      <div className="flex flex-wrap gap-2">
                        {AMENITIES.filter(a => selectedAmenities[a.id]).map(a => (
                          <Badge key={a.id} variant="secondary">{a.label}</Badge>
                        ))}
                        {AMENITIES.filter(a => selectedAmenities[a.id]).length === 0 && (
                          <span className="text-sm text-muted-foreground">None selected</span>
                        )}
                      </div>
                    </div>
                    <div className="pt-4 border-t space-y-2">
                      <div className="flex justify-between text-lg font-bold">
                        <span>Total Registration Fee</span>
                        <span className="text-primary">₹{calculateFee().totalFee.toFixed(2)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Single consolidated amount as per HP Tourism Policy 2025 (no per-room or GST add-ons).
                      </p>
                    </div>
                  </CardContent>
                </Card>

                {/* Additional Facilities */}
                {(form.watch("ecoFriendlyFacilities") || form.watch("differentlyAbledFacilities") || form.watch("fireEquipmentDetails") || form.watch("nearestHospital")) && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Additional Facilities</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      {form.watch("ecoFriendlyFacilities") && (
                        <div><span className="text-muted-foreground">Eco-Friendly:</span> <p className="mt-1">{form.watch("ecoFriendlyFacilities")}</p></div>
                      )}
                      {form.watch("differentlyAbledFacilities") && (
                        <div><span className="text-muted-foreground">Differently-Abled Facilities:</span> <p className="mt-1">{form.watch("differentlyAbledFacilities")}</p></div>
                      )}
                      {form.watch("fireEquipmentDetails") && (
                        <div><span className="text-muted-foreground">Fire Equipment:</span> <p className="mt-1">{form.watch("fireEquipmentDetails")}</p></div>
                      )}
                      {form.watch("nearestHospital") && (
                        <div><span className="text-muted-foreground">Nearest Hospital:</span> <p className="mt-1">{form.watch("nearestHospital")}</p></div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            </ScrollArea>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
