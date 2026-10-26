import { Body, Controller, Get, Param, Patch, Post, Delete, Query } from '@nestjs/common';
import {
  registerPatientSchema,
  readmitPatientSchema,
  dischargePatientSchema,
  patientClinicalUpdateSchema,
  tagPatientMachineSchema,
  changePatientDoctorSchema,
  updatePatientIdentitySchema,
  linkPatientsSchema,
  unlinkPatientSchema,
  movePatientSchema,
  ROLES,
  type RegisterPatientInput,
  type ReadmitPatientInput,
  type DischargePatientInput,
  type PatientClinicalUpdateInput,
  type TagPatientMachineInput,
  type ChangePatientDoctorInput,
  type UpdatePatientIdentityInput,
  type LinkPatientsInput,
  type UnlinkPatientInput,
  type MovePatientInput,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { PatientsService } from './patients.service.js';
import { MachinesService } from '../machines/machines.service.js';

@Controller('patients')
export class PatientsController {
  constructor(
    private readonly patients: PatientsService,
    private readonly machines: MachinesService,
  ) {}

  @Roles(...ROLES)
  @Get()
  list(@Query('search') search?: string, @Query('doctorId') doctorId?: string) {
    return this.patients.list(search, doctorId);
  }

  @Roles('reception', 'admin')
  @Get('dashboard')
  dashboard() {
    return this.patients.dashboard();
  }

  // Duplicate IPs of one person: admin links them to a main IP and delinks
  // them; every link and delink is recorded in each patient's history.
  @Roles('admin')
  @Get('links')
  listLinks() {
    return this.patients.listLinks();
  }

  @Roles('admin')
  @Post('links')
  link(@Body(new ZodValidationPipe(linkPatientsSchema)) body: LinkPatientsInput, @CurrentUser() user: AuthenticatedUser) {
    return this.patients.linkPatients(body, user);
  }

  @Roles('admin')
  @Post(':id/unlink')
  unlink(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(unlinkPatientSchema)) body: UnlinkPatientInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patients.unlinkPatient(id, body, user);
  }

  @Roles(...ROLES)
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.patients.getById(id);
  }

  @Roles('admin', 'reception')
  @Post()
  register(@Body(new ZodValidationPipe(registerPatientSchema)) body: RegisterPatientInput, @CurrentUser() user: AuthenticatedUser) {
    return this.patients.register(body, user);
  }

  @Roles('admin', 'reception')
  @Post(':id/readmit')
  readmit(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(readmitPatientSchema)) body: ReadmitPatientInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patients.readmit(id, body, user);
  }

  @Roles('admin', 'reception')
  @Post(':id/discharge')
  discharge(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(dischargePatientSchema)) body: DischargePatientInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patients.discharge(id, body, user);
  }

  // Reception corrects identity details; IP number and name stay fixed (the
  // schema rejects them). Recorded in the history.
  @Roles('admin', 'reception')
  @Patch(':id/identity')
  updateIdentity(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePatientIdentitySchema)) body: UpdatePatientIdentityInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patients.updateIdentity(id, body, user);
  }

  // Reception moves a patient to another room; their machines move with them.
  @Roles('admin', 'reception')
  @Patch(':id/room')
  moveRoom(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(movePatientSchema)) body: MovePatientInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patients.moveToRoom(id, body, user);
  }

  // Reception moves a patient to another attending doctor (wrong doctor at
  // registration, doctor unavailable, a new issue); recorded in the history.
  @Roles('admin', 'reception')
  @Patch(':id/doctor')
  changeDoctor(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changePatientDoctorSchema)) body: ChangePatientDoctorInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patients.changeDoctor(id, body, user);
  }

  @Roles('admin', 'doctor')
  @Patch(':id/clinical')
  updateClinical(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(patientClinicalUpdateSchema)) body: PatientClinicalUpdateInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patients.updateClinical(id, body, user);
  }

  // Admin-only (narrowed from admin/doctor/reception — plan M7 §7): reverses
  // the original M2 decision now that bedside machine-initiated tagging
  // exists as a separate actor path (assignedByMachineId) with its own rules.
  @Roles('admin')
  @Patch(':id/machine')
  tagMachine(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(tagPatientMachineSchema)) body: TagPatientMachineInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.machines.assignPatientToMachine(id, body.machineId, user);
  }

  @Roles('admin')
  @Delete(':id/machine/:machineId')
  untagMachine(@Param('id') id: string, @Param('machineId') machineId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.machines.unassignPatientFromMachine(id, machineId, user);
  }
}
