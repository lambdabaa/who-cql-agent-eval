/*
 * Library: IMMZD2DTMeaslesLowTransmissionLogic
 * Decision: IMMZ.D2.DT.Measles.Low transmission
 */
library IMMZD2DTMeaslesLowTransmissionLogic

using FHIR version '4.0.1'

include FHIRHelpers version '4.0.1'
include IMMZD2DTMeaslesEncounterElements called Encounter

parameter Today Date default Today()

context Patient

/*
@output: Client is not due for MCV1 Case 1
*/
define "Client is not due for MCV1 Case 1":
  Encounter."Client's age is less than 12 months"

/*
@output: Client is due for MCV1
*/
define "Client is due for MCV1":
  Encounter."No measles primary series doses were administered"
  and Encounter."Client's age is more than or equal to 12 months"
  and Encounter."No live vaccine was administered in the last 4 weeks"

/*
@output: Client is not due for MCV1 Case 2
*/
define "Client is not due for MCV1 Case 2":
  Encounter."No measles primary series doses were administered"
  and Encounter."Client's age is more than or equal to 12 months"
  and Encounter."Live vaccine was administered in the last 4 weeks"

/*
@output: Client is not due for MCV2 Case 1
*/
define "Client is not due for MCV2 Case 1":
  Encounter."MCV1 was administered"
  and Encounter."Client's age is less than 15 months"

/*
@output: Client is due for MCV2
*/
define "Client is due for MCV2":
  Encounter."MCV1 was administered"
  and Encounter."Client's age is more than or equal to 15 months"
  and Encounter."No live vaccine was administered in the last 4 weeks"

/*
@output: Client is not due for MCV2 Case 2
*/
define "Client is not due for MCV2 Case 2":
  Encounter."MCV1 was administered"
  and Encounter."Client's age is more than or equal to 15 months"
  and Encounter."Live vaccine was administered in the last 4 weeks"

/*
@output: Measles primary series is complete
*/
define "Measles primary series is complete":
  Encounter."MCV2 was administered"

/*
@output: Client is not due for MCV1
*/
define "Client is not due for MCV1":
  "Client is not due for MCV1 Case 1" or "Client is not due for MCV1 Case 2"

/*
@output: Client is not due for MCV2
*/
define "Client is not due for MCV2":
  "Client is not due for MCV2 Case 1" or "Client is not due for MCV2 Case 2"

/*
@guidance: Client is due for MCV1 Guidance
*/
define "Client is due for MCV1 Guidance":
  'Should vaccinate client with MCV1 as no measles doses were administered, client is within appropriate age range and no live vaccine was administered in the past 4 weeks.\nCheck for contraindications.'

/*
@guidance: Client is due for MCV2 Guidance
*/
define "Client is due for MCV2 Guidance":
  'Should vaccinate client with MCV2 as client is within appropriate age range and no live vaccine administered in the past 4 weeks.\nCheck for contraindications.'

/*
@guidance: Measles primary series is complete Guidance
*/
define "Measles primary series is complete Guidance":
  'Measles primary series is complete. Two measles primary series doses were administered.\nCheck if a measles supplementary dose is appropriate for the client.'

/*
@guidance: Client is not due for MCV1 Case 1 Guidance
*/
define "Client is not due for MCV1 Case 1 Guidance":
  'Should not vaccinate client with MCV1 as client\'s age is less than 12 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.'

/*
@guidance: Client is not due for MCV1 Case 2 Guidance
*/
define "Client is not due for MCV1 Case 2 Guidance":
  'Should not vaccinate client with MCV1 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.'

/*
@guidance: Client is not due for MCV2 Case 1 Guidance
*/
define "Client is not due for MCV2 Case 1 Guidance":
  'Should not vaccinate client with MCV2 as client\'s age is less than 15 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.'

/*
@guidance: Client is not due for MCV2 Case 2 Guidance
*/
define "Client is not due for MCV2 Case 2 Guidance":
  'Should not vaccinate client with MCV2 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.'

/*
@guidance: Client is not due for MCV1 Guidance
*/
define "Client is not due for MCV1 Guidance":
  case
    when "Client is not due for MCV1 Case 1" then 'Should not vaccinate client with MCV1 as client\'s age is less than 12 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.'
    when "Client is not due for MCV1 Case 2" then 'Should not vaccinate client with MCV1 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.'
    else ''
  end

/*
@guidance: Client is not due for MCV2 Guidance
*/
define "Client is not due for MCV2 Guidance":
  case
    when "Client is not due for MCV2 Case 1" then 'Should not vaccinate client with MCV2 as client\'s age is less than 15 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.'
    when "Client is not due for MCV2 Case 2" then 'Should not vaccinate client with MCV2 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.'
    else ''
  end

/*
@dynamicValue: Guidance
*/
define "Guidance":
  case
    when "Client is not due for MCV1" then "Client is not due for MCV1 Guidance"
    when "Client is due for MCV1" then "Client is due for MCV1 Guidance"
    when "Client is not due for MCV2" then "Client is not due for MCV2 Guidance"
    when "Client is due for MCV2" then "Client is due for MCV2 Guidance"
    when "Measles primary series is complete" then "Measles primary series is complete Guidance"
    else ''
  end

define "Has Guidance":
  "Guidance" is not null and "Guidance" != ''