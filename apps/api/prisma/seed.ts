import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

// Local-dev-only seed data — every account is created with
// mustChangePassword: true, so these passwords are never usable past first
// login. Never reuse this script's credentials for a real deployment.
const prisma = new PrismaClient();

const SEED_USERS = [
  { loginId: 'admin', password: 'Admin@12345', role: 'admin' as const },
  { loginId: 'reception', password: 'Reception@12345', role: 'reception' as const },
  { loginId: 'pharmacy', password: 'Pharmacy@12345', role: 'pharmacy' as const },
  { loginId: 'insurance', password: 'Insurance@12345', role: 'insurance' as const },
  { loginId: 'superuser', password: 'Superuser@12345', role: 'superuser' as const },
];

async function main() {
  for (const seedUser of SEED_USERS) {
    const passwordHash = await argon2.hash(seedUser.password, { type: argon2.argon2id });
    await prisma.user.upsert({
      where: { loginId: seedUser.loginId },
      update: {},
      create: {
        loginId: seedUser.loginId,
        role: seedUser.role,
        passwordHash,
        mustChangePassword: true,
      },
    });
    console.log(`Seeded ${seedUser.role}: ${seedUser.loginId} / ${seedUser.password} (must change on first login)`);
  }

  const doctorPasswordHash = await argon2.hash('Doctor@12345', { type: argon2.argon2id });
  const doctorUser = await prisma.user.upsert({
    where: { loginId: 'doctor' },
    update: {},
    create: {
      loginId: 'doctor',
      role: 'doctor',
      passwordHash: doctorPasswordHash,
      mustChangePassword: true,
    },
  });
  await prisma.doctorProfile.upsert({
    where: { userId: doctorUser.id },
    update: {},
    create: {
      userId: doctorUser.id,
      name: 'Sandeep Matari',
      specialty: 'General Medicine',
      qualification: 'MBBS',
    },
  });
  console.log('Seeded doctor: doctor / Doctor@12345 (must change on first login)');

  const SEED_MACHINES = [
    { machineCode: 'PUMP-001', machineType: 'INFUSION_PUMP', location: 'ICU Room 3' },
    { machineCode: 'ECMO-001', machineType: 'ECMO', location: 'ICU Room 1' },
  ];
  // The admin's room list starts with the rooms these machines stand in.
  for (const name of ['ICU Room 1', 'ICU Room 2', 'ICU Room 3']) {
    await prisma.room.upsert({ where: { name }, update: {}, create: { name } });
  }
  for (const m of SEED_MACHINES) {
    const room = await prisma.room.findUnique({ where: { name: m.location } });
    await prisma.machine.upsert({
      where: { machineCode: m.machineCode },
      update: {},
      create: { ...m, roomId: room?.id },
    });
    console.log(`Seeded machine: ${m.machineCode} (${m.machineType})`);
  }

  const REJECTION_REASONS = [
    ['R001', 'Policy Not Found'],
    ['R002', 'Policy Expired'],
    ['R003', 'Policy Inactive'],
    ['R004', 'Premium Pending'],
    ['R005', 'Treatment Not Covered'],
    ['R006', 'Waiting Period Not Completed'],
    ['R007', 'Sum Insured Exhausted'],
    ['R008', 'Invalid Insurance ID'],
    ['R009', 'Patient Details Mismatch'],
    ['R010', 'Hospital Not in Network'],
    ['R011', 'Missing Documents'],
    ['R012', 'Duplicate Claim'],
    ['R013', 'Claim Already Settled'],
    ['R014', 'Prior Authorization Required'],
    ['R015', 'Fraud Suspected'],
    ['R016', 'Medical Necessity Not Established'],
    ['R017', 'Invalid Diagnosis'],
    ['R018', 'Invalid Procedure'],
    ['R019', 'Coverage Limit Exceeded'],
    ['R020', 'Other (Specify Remarks)'],
  ] as const;
  for (const [code, description] of REJECTION_REASONS) {
    await prisma.insuranceRejectionReason.upsert({ where: { code }, update: {}, create: { code, description } });
  }
  console.log(`Seeded ${REJECTION_REASONS.length} insurance rejection reasons`);

  await prisma.insuranceCompany.upsert({
    where: { name: 'Star Health Insurance' },
    update: {},
    create: { name: 'Star Health Insurance' },
  });
  console.log('Seeded insurance company: Star Health Insurance');

  await prisma.medicine.upsert({
    where: { medicineCode: 'MED-NS-500' },
    update: {},
    create: {
      medicineCode: 'MED-NS-500',
      name: 'Normal Saline',
      genericName: 'Sodium Chloride 0.9%',
      concentration: '0.9%',
      unitMl: 500,
      stockQty: 100,
      minStock: 10,
      reorderLevel: 20,
      pricePerUnit: 45,
      status: 'ACTIVE',
      // Cap fields exercised by the shared infusion.schema.ts cap-checker —
      // see M1's InfusionCapService tests for the values these guard against.
      maxFlowRateMlPerH: 200,
      maxSingleDoseMl: 1000,
      absoluteMaxFlowRateMlPerH: 300,
    },
  });
  console.log('Seeded medicine: Normal Saline (MED-NS-500)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
