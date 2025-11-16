import bcrypt from "bcrypt";
import { db } from "../server/db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";
const mobile = process.argv[2] || "6666667770";
const password = process.argv[3] || "test123";
async function main() {
    const hashed = await bcrypt.hash(password, 10);
    const updated = await db
        .update(users)
        .set({ password: hashed })
        .where(eq(users.mobile, mobile))
        .returning({ mobile: users.mobile });
    if (!updated.length) {
        console.log(`No user found for ${mobile}`);
        process.exit(1);
    }
    console.log(`Password reset for ${mobile}`);
}
main().catch((error) => {
    console.error("Reset failed", error);
    process.exit(1);
});
