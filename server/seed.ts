import bcrypt from 'bcrypt';
import { db } from './db';
import { users, ddoCodes } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * Database Seed Script
 * Creates default admin user and initial data for the HP Tourism portal
 * Safe to run multiple times (idempotent)
 */

async function seed() {
  console.log('🌱 Starting database seed...');

  try {
    // Check if admin user already exists
    const adminMobile = '9999999999';
    const adminPassword = 'admin123';
    const hashedAdminPassword = await bcrypt.hash(adminPassword, 10);

    const existingAdmin = await db.select()
      .from(users)
      .where(eq(users.mobile, adminMobile))
      .limit(1);

    if (existingAdmin.length > 0) {
      console.log(`✅ Admin user already exists (mobile: ${adminMobile})`);
      
      // Update to ensure role, status, and password are correct
      await db.update(users)
        .set({ role: 'admin', isActive: true, password: hashedAdminPassword })
        .where(eq(users.mobile, adminMobile));
      
      console.log('✅ Admin credentials verified/updated');
    } else {
      // Create default admin user
      await db.insert(users).values({
        mobile: adminMobile,
        password: hashedAdminPassword,
        fullName: 'System Administrator',
        role: 'admin',
        isActive: true,
      });
      
      console.log('✅ Admin user created successfully');
      console.log(`   Mobile: ${adminMobile}`);
      console.log(`   Password: ${adminPassword}`);
      console.log('   ⚠️  IMPORTANT: Change this password in production!');
    }

    // Seed DDO codes for district-wise payment routing
    console.log('🏛️  Seeding DDO codes for all districts...');
    
    const ddoData = [
      { district: 'Chamba', ddoCode: 'CHM00-532', ddoDescription: 'D.T.D.O. CHAMBA', treasuryCode: 'CHM00' },
      { district: 'Bharmour', ddoCode: 'CHM01-001', ddoDescription: 'S.D.O.(CIVIL) BHARMOUR', treasuryCode: 'CHM01' },
      { district: 'Shimla (Central)', ddoCode: 'CTO00-068', ddoDescription: 'A.C. (TOURISM) SHIMLA', treasuryCode: 'CTO00' },
      { district: 'Hamirpur', ddoCode: 'HMR00-053', ddoDescription: 'DISTRICT TOURISM DEVELOPMENT OFFICE HAMIRPUR (UNA)', treasuryCode: 'HMR00' },
      { district: 'Kullu (Dhalpur)', ddoCode: 'KLU00-532', ddoDescription: 'DEPUTY DIRECTOR TOURISM AND CIVIL AVIATION KULLU DHALPUR', treasuryCode: 'KLU00' },
      { district: 'Kullu', ddoCode: 'KLU04-532', ddoDescription: 'DEPUTY DIRECTOR, TOURISM &CIVIL AVIATION, KULLU', treasuryCode: 'KLU04' },
      { district: 'Kangra', ddoCode: 'KNG00-532', ddoDescription: 'DIV.TOURISM DEV.OFFICER(DTDO) DHARAMSALA', treasuryCode: 'KNG00' },
      { district: 'Kinnaur', ddoCode: 'KNR00-031', ddoDescription: 'DISTRICT TOURISM DEVELOPMENT OFFICER KINNAUR AT RECKONG PEO', treasuryCode: 'KNR00' },
      { district: 'Lahaul-Spiti (Kaza)', ddoCode: 'KZA00-011', ddoDescription: 'PO ITDP KAZA', treasuryCode: 'KZA00' },
      { district: 'Lahaul', ddoCode: 'LHL00-017', ddoDescription: 'DISTRICT TOURISM DEVELOPMENT OFFICER', treasuryCode: 'LHL00' },
      { district: 'Mandi', ddoCode: 'MDI00-532', ddoDescription: 'DIV. TOURISM DEV. OFFICER MANDI', treasuryCode: 'MDI00' },
      { district: 'Pangi', ddoCode: 'PNG00-003', ddoDescription: 'PROJECT OFFICER ITDP PANGI', treasuryCode: 'PNG00' },
      { district: 'Shimla', ddoCode: 'SML00-532', ddoDescription: 'DIVISIONAL TOURISM OFFICER SHIMLA', treasuryCode: 'SML00' },
      { district: 'Sirmour', ddoCode: 'SMR00-055', ddoDescription: 'DISTRICT TOURISM DEVELOPMENT OFFICE NAHAN', treasuryCode: 'SMR00' },
      { district: 'Solan', ddoCode: 'SOL00-046', ddoDescription: 'DTDO SOLAN', treasuryCode: 'SOL00' },
    ];

    // Insert DDO codes (skip if already exist)
    for (const ddo of ddoData) {
      const existing = await db.select()
        .from(ddoCodes)
        .where(eq(ddoCodes.district, ddo.district))
        .limit(1);
      
      if (existing.length === 0) {
        await db.insert(ddoCodes).values(ddo);
      }
    }
    
    console.log(`✅ DDO codes seeded successfully (${ddoData.length} districts)`);

    // Create super_admin account for system maintenance operations
    console.log('👑 Creating super admin account...');
    
    const superAdminMobile = '9999999998';
    const superAdminPassword = 'ulan@2025';
    const hashedSuperAdminPassword = await bcrypt.hash(superAdminPassword, 10);

    const existingSuperAdmin = await db.select()
      .from(users)
      .where(eq(users.mobile, superAdminMobile))
      .limit(1);

    if (existingSuperAdmin.length > 0) {
      console.log(`✅ Super admin user already exists (mobile: ${superAdminMobile})`);
      
      // Update to ensure role, status, and password are correct
      await db.update(users)
        .set({ role: 'super_admin', isActive: true, password: hashedSuperAdminPassword })
        .where(eq(users.mobile, superAdminMobile));
      
      console.log('✅ Super admin credentials verified/updated');
    } else {
      // Create super admin user
      await db.insert(users).values({
        mobile: superAdminMobile,
        email: 'superadmin@himachaltourism.gov.in',
        password: hashedSuperAdminPassword,
        fullName: 'Super Administrator',
        role: 'super_admin',
        isActive: true,
      });
      
      console.log('✅ Super admin user created successfully');
      console.log(`   Mobile: ${superAdminMobile}`);
      console.log('   Email: superadmin@himachaltourism.gov.in');
      console.log(`   Password: ${superAdminPassword}`);
      console.log('   ⚠️  IMPORTANT: This account has full system access including reset operations!');
      console.log('   ⚠️  Change this password immediately after first login!');
    }

    // Create test Dealing Assistant account for Shimla district
    console.log('🔍 Creating test Dealing Assistant account...');
    
    const existingDA = await db.select()
      .from(users)
      .where(eq(users.mobile, '9876543210'))
      .limit(1);

    if (existingDA.length > 0) {
      console.log('✅ Dealing Assistant user already exists (mobile: 9876543210)');
      
      // Update role, district, AND password to ensure correct credentials
      const hashedDAPassword = await bcrypt.hash('da123', 10);
      
      await db.update(users)
        .set({ 
          role: 'dealing_assistant', 
          district: 'Shimla',
          password: hashedDAPassword,
          fullName: 'Priya Sharma (DA Shimla)',
          isActive: true 
        })
        .where(eq(users.mobile, '9876543210'));
      
      console.log('✅ Dealing Assistant role, district, and password updated');
      console.log('   Password reset to: da123');
    } else {
      // Create test DA user for Shimla
      const hashedDAPassword = await bcrypt.hash('da123', 10);
      
      await db.insert(users).values({
        mobile: '9876543210',
        email: 'da.shimla@himachaltourism.gov.in',
        password: hashedDAPassword,
        fullName: 'Priya Sharma (DA Shimla)',
        role: 'dealing_assistant',
        district: 'Shimla',
        isActive: true,
      });
      
      console.log('✅ Dealing Assistant user created successfully');
      console.log('   Mobile: 9876543210');
      console.log('   Email: da.shimla@himachaltourism.gov.in');
      console.log('   Password: da123');
      console.log('   District: Shimla');
      console.log('   ⚠️  For testing only - change password in production!');
    }

    console.log('\n📋 Summary of Default Accounts:');
    console.log('┌────────────────────┬──────────────┬──────────────────┬──────────────────────┐');
    console.log('│ Role               │ Mobile       │ Password         │ Access Level         │');
    console.log('├────────────────────┼──────────────┼──────────────────┼──────────────────────┤');
    console.log('│ Admin              │ 9999999999   │ admin123         │ User Management      │');
    console.log('│ Super Admin        │ 9999999998   │ SuperAdmin@2025  │ Full System + Reset  │');
    console.log('│ Dealing Assistant  │ 9876543210   │ da123            │ Shimla District      │');
    console.log('└────────────────────┴──────────────┴──────────────────┴──────────────────────┘');

    console.log('\n🎉 Database seed completed successfully!');
    console.log('   Run this script anytime to ensure default accounts and DDO codes exist.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database seed failed:', error);
    process.exit(1);
  }
}

// Run seed
seed();
