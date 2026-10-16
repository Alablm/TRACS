import { describe, expect, it } from 'vitest'
import { formatTacasAircrewCheckIn, getTacasAircrewCheckInDefaults, TACAS_AIRCREW_CHECK_IN_FIELDS } from '../../client/src/modules/tacas/aircrewCheckIn.js'
import { formatTacasNineLine, formatTargetElevation, TACAS_NINE_LINE_FIELDS } from '../../client/src/modules/tacas/nineLine.js'
import { formatCoordinates, formatDecimal, formatMetricCoordinates } from '../../client/src/utils/coords.js'
import { setProjectionParams } from '../../client/src/utils/magvar.js'

describe('TACAS 9-line formatting', () => {
  it('formats coordinates in DMS, decimal, and MGRS', () => {
    expect(formatCoordinates(41.5, 43.5, 'dms')).toBe(`N41°30'00.00" E043°30'00.00"`)
    expect(formatCoordinates(41.5, 43.5, 'decimal')).toBe('41.500000, 43.500000')
    expect(formatCoordinates(41.5, 43.5, 'mgrs')).toBe('38T LL 74804 95350')
    expect(formatCoordinates(41.5, 43.5, 'ddm')).toBe(`N41°30.000' E043°30.000'`)
    expect(formatDecimal(-41.5, -43.5)).toBe('-41.500000, -43.500000')
  })

  describe('TACAS Aircrew check-in formatting', () => {
    it('prefills callsign, aircraft type, and abort code', () => {
      expect(getTacasAircrewCheckInDefaults('RAVEN11', {
        callsign: 'RAVEN11',
        typeName: 'F-16C',
      })).toEqual({
        identification: 'RAVEN11',
        aircraft: '1x F-16C',
        abortCode: 'SIERRA SIERRA SIERRA',
      })
    })

    it('uses the signed-in callsign if no live aircraft match is available', () => {
      expect(getTacasAircrewCheckInDefaults('RAVEN11', undefined)).toEqual({
        identification: 'RAVEN11',
        aircraft: '1x',
        abortCode: 'SIERRA SIERRA SIERRA',
      })
    })

    it('formats all eight lines and trims user-entered values', () => {
      expect(formatTacasAircrewCheckIn({
        identification: '  Viper  ',
        aircraft: '2 x F-16',
        positionAltitude: 'Bullseye 270/15, 20,000 ft',
        ordnance: '2x GBU-12',
        playtime: '45 min',
        capabilities: 'CAS, FAC(A)',
        abortCode: 'LIMA',
        remarks: 'Ready',
      })).toBe([
        '1. Identification and/or Mission Number: Viper',
        '2. Number and Type of Aircraft: 2 x F-16',
        '3. Position and Altitude: Bullseye 270/15, 20,000 ft',
        '4. Ordnance: 2x GBU-12',
        '5. Playtime: 45 min',
        '6. Capabilities: CAS, FAC(A)',
        '7. Abort Code: LIMA',
        '8. Remarks: Ready',
      ].join('\n'))
    })

    it('keeps a fully populated check-in within the TACAS chat limit', () => {
      const values = Object.fromEntries(
        TACAS_AIRCREW_CHECK_IN_FIELDS.map(({ key, maxLength }) => [key, 'x'.repeat(maxLength)])
      )

      expect(formatTacasAircrewCheckIn(values).length).toBeLessThanOrEqual(500)
    })
  })

  it('formats theatre-specific absolute metric X/Y coordinates', () => {
    setProjectionParams({
      Test: { central_meridian: 0, false_easting: 1000, false_northing: 2000, scale_factor: 1 },
    })

    expect(formatCoordinates(0, 0, 'metric', 'Test')).toBe('X: 2000 m, Y: 1000 m')
    expect(formatMetricCoordinates(0, 0, 'Unknown')).toBeNull()
  })

  it('formats target terrain elevation in feet MSL', () => {
    expect(formatTargetElevation(100)).toBe('328 ft MSL')
    expect(formatTargetElevation(null)).toBeNull()
  })

  it('formats target terrain elevation in meters MSL when requested', () => {
    expect(formatTargetElevation(100, 'm')).toBe('100 m MSL')
  })

  it('formats all nine lines and trims user-entered values', () => {
    expect(formatTacasNineLine({
      ipBp: '  Alpha  ',
      targetLocation: '41.123456, 43.654321',
      egress: 'East',
    })).toBe([
      '1. IP/BP: Alpha',
      '2. Heading: ',
      '3. Distance: ',
      '4. Target Elevation: ',
      '5. Target Description: ',
      '6. Target Location: 41.123456, 43.654321',
      '7. Mark Type: ',
      '8. Friendlies: ',
      '9. Egress: East',
      '10. Remarks: ',
    ].join('\n'))
  })

  it('keeps a fully populated brief within the TACAS chat limit', () => {
    const values = Object.fromEntries(
      TACAS_NINE_LINE_FIELDS.map(({ key, maxLength }) => [key, 'x'.repeat(maxLength)])
    )

    expect(formatTacasNineLine(values).length).toBeLessThanOrEqual(500)
  })
})
