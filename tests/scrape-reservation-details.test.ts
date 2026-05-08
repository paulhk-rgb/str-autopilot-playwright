import { describe, expect, it } from 'vitest';

import {
  __reservationDetailScraperTestHooks,
} from '../src/playwright/scrape-reservation-details';
import {
  __scrapeReservationDetailsEndpointTestHooks,
} from '../src/endpoints/scrape-reservation-details';

function detailPayload(sectionOverrides: Record<string, unknown> = {}) {
  return {
    data: {
      presentation: {
        hostingDetails: {
          stayHostingDetails: {
            rootPlacement: [
              {
                sectionData: {
                  __typename: 'HostingDetailsPaymentInfoSection',
                  summaryLineItem: {
                    label: 'Total for 2 nights',
                    formattedValue: '$1,071.85',
                  },
                  guestPaidGroup: {
                    groupName: 'Guest paid',
                    lineItems: [
                      { label: '$525.00 x 2 nights', formattedValue: '$1,050.00' },
                      { label: 'Cleaning fee', formattedValue: '$55.00' },
                      { label: 'Guest service fee', formattedValue: '$156.00' },
                      { label: 'Occupancy taxes', formattedValue: '$156.13' },
                    ],
                    totalLineItem: { label: 'Total (USD)', formattedValue: '$1,417.13' },
                  },
                  hostEarningsGroup: {
                    groupName: 'You earn',
                    lineItems: [
                      { label: '2 nights room fee', formattedValue: '$1,050.00' },
                      { label: 'Cleaning fee', formattedValue: '$55.00' },
                      { label: 'Host service fee (3.0%)', formattedValue: '-$33.15' },
                    ],
                    totalLineItem: { label: 'Total (USD)', formattedValue: '$1,071.85' },
                  },
                  ...sectionOverrides,
                },
              },
            ],
          },
        },
      },
    },
  };
}

describe('reservation detail scraper extraction helpers', () => {
  it('extracts host and guest payment groups from Airbnb detail JSON', () => {
    const detail = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'hm3zxpmnzc',
      detailPayload(),
      'USD',
    );

    expect(detail).toEqual(
      expect.objectContaining({
        conf_code: 'HM3ZXPMNZC',
        currency: 'USD',
        nights_from_detail: 2,
        financials: {
          guest_total: 1417.13,
          accommodation_amount: 1050,
          guest_service_fee: 156,
          occupancy_taxes: 156.13,
          host_payout: 1071.85,
          host_room_amount: 1050,
          cleaning_fee: 55,
          host_service_fee_amount: 33.15,
          adjustment_amount: null,
        },
      }),
    );
    expect(detail?.guest_paid_group.line_items).toHaveLength(4);
    expect(detail?.host_earnings_group.line_items).toHaveLength(3);
  });

  it('keeps known adjustment line items in reconciliation without warning on them', () => {
    const detail = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'HMOLD123',
      detailPayload({
        summaryLineItem: { label: 'Total for 2 nights', formattedValue: '$271.60' },
        guestPaidGroup: {
          groupName: 'Guest paid',
          lineItems: [
            { label: '$120 x 2 nights', formattedValue: '$240.00' },
            { label: 'Cleaning fee', formattedValue: '$40.00' },
            { label: 'Guest service fee', formattedValue: '$36.12' },
            { label: 'Occupancy taxes', formattedValue: '$8.40' },
          ],
          totalLineItem: { label: 'Total (USD)', formattedValue: '$324.52' },
        },
        hostEarningsGroup: {
          groupName: 'You earn',
          lineItems: [
            { label: '2 nights room fee', formattedValue: '$300.00' },
            { label: 'Cleaning fee', formattedValue: '$40.00' },
            { label: 'Nightly rate adjustment', formattedValue: '-$60.00' },
            { label: 'Host service fee (3.0%)', formattedValue: '-$8.40' },
          ],
          totalLineItem: { label: 'Total (USD)', formattedValue: '$271.60' },
        },
      }),
      'USD',
    );

    expect(detail?.financials.adjustment_amount).toBe(-60);
    expect(detail?.unknown_host_line_labels).toEqual([]);
  });

  it('keeps pet fees separate from cleaning while including them in adjustment reconciliation', () => {
    const detail = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'HMPET123',
      detailPayload({
        summaryLineItem: { label: 'Total for 2 nights', formattedValue: '$1,116.85' },
        guestPaidGroup: {
          groupName: 'Guest paid',
          lineItems: [
            { label: '$525.00 x 2 nights', formattedValue: '$1,050.00' },
            { label: 'Cleaning fee', formattedValue: '$55.00' },
            { label: 'Pet fee', formattedValue: '$45.00' },
            { label: 'Guest service fee', formattedValue: '$156.00' },
            { label: 'Occupancy taxes', formattedValue: '$156.13' },
          ],
          totalLineItem: { label: 'Total (USD)', formattedValue: '$1,462.13' },
        },
        hostEarningsGroup: {
          groupName: 'You earn',
          lineItems: [
            { label: '2 nights room fee', formattedValue: '$1,050.00' },
            { label: 'Cleaning fee', formattedValue: '$55.00' },
            { label: 'Pet fee', formattedValue: '$45.00' },
            { label: 'Host service fee (3.0%)', formattedValue: '-$33.15' },
          ],
          totalLineItem: { label: 'Total (USD)', formattedValue: '$1,116.85' },
        },
      }),
      'USD',
    );

    expect(detail?.financials.cleaning_fee).toBe(55);
    expect(detail?.financials.adjustment_amount).toBe(45);
    expect(detail?.unknown_host_line_labels).toEqual([]);
  });

  it('still warns on truly unknown host amount lines while preserving their math', () => {
    const detail = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'HMUNK123',
      detailPayload({
        summaryLineItem: { label: 'Total for 2 nights', formattedValue: '$1,121.85' },
        hostEarningsGroup: {
          groupName: 'You earn',
          lineItems: [
            { label: '2 nights room fee', formattedValue: '$1,050.00' },
            { label: 'Cleaning fee', formattedValue: '$55.00' },
            { label: 'Pet fee', formattedValue: '$45.00' },
            { label: 'Mystery host credit', formattedValue: '$5.00' },
            { label: 'Host service fee (3.0%)', formattedValue: '-$33.15' },
          ],
          totalLineItem: { label: 'Total (USD)', formattedValue: '$1,121.85' },
        },
      }),
      'USD',
    );

    expect(detail?.financials.adjustment_amount).toBe(50);
    expect(detail?.unknown_host_line_labels).toEqual(['Mystery host credit']);
  });

  it('does not mistake carpet fees for pet fees', () => {
    expect(
      __reservationDetailScraperTestHooks.isKnownHostAdjustmentLine({
        label: 'Carpet fee',
        formatted_value: '$45.00',
        amount: 45,
      }),
    ).toBe(false);
  });

  it('returns null when the payment section is missing instead of inventing zeros', () => {
    const detail = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'HMABC123',
      { data: { presentation: { unrelated: true } } },
      'USD',
    );

    expect(detail).toBeNull();
  });

  it('rejects detail payloads that identify a different confirmation code', () => {
    const matching = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'HMABC123',
      detailPayload({ confirmationCode: 'hmabc123' }),
      'USD',
    );
    const mismatched = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'HMABC123',
      detailPayload({ confirmationCode: 'HMDIFFERENT' }),
      'USD',
    );
    const mismatchedFutureFormat = __reservationDetailScraperTestHooks.extractReservationDetailFromJson(
      'HMABC123',
      detailPayload({ confirmationCode: 'LEGACY123' }),
      'USD',
    );

    expect(matching?.conf_code).toBe('HMABC123');
    expect(mismatched).toBeNull();
    expect(mismatchedFutureFormat).toBeNull();
    expect(
      Array.from(
        __reservationDetailScraperTestHooks.collectPayloadConfirmationCodes({
          nested: { confirmationCodeMA: 'hmabc123' },
        }),
      ),
    ).toEqual(['HMABC123']);
  });

  it('rewrites only the confirmation code variable in a bootstrapped query URL', () => {
    const url = __reservationDetailScraperTestHooks.detailUrlForConfirmation(
      'https://www.airbnb.com/api/v3/StayHostingDetailsQuery/hash?operationName=StayHostingDetailsQuery&locale=en&currency=USD&variables=%7B%22confirmationCode%22%3A%22HMOLD%22%2C%22requestSource%22%3A%22RESERVATION_LIST%22%2C%22viewerTimeZoneOffset%22%3A-240%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22hash%22%7D%7D',
      'HMNEW123',
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('currency')).toBe('USD');
    expect(JSON.parse(parsed.searchParams.get('variables') ?? '{}')).toEqual({
      confirmationCode: 'HMNEW123',
      requestSource: 'RESERVATION_LIST',
      viewerTimeZoneOffset: -240,
    });
  });

  it('tries both reservations all and reservation details routes when bootstrapping detail query', () => {
    expect(
      __reservationDetailScraperTestHooks.detailBootstrapUrlsForConfirmation('HMABC 123'),
    ).toEqual([
      'https://www.airbnb.com/hosting/reservations/all?locale=en&confirmationCode=HMABC%20123',
      'https://www.airbnb.com/hosting/reservations/details/HMABC%20123',
    ]);
  });

  it('drops reservation-specific bootstrap variables when replaying another code', () => {
    const url = __reservationDetailScraperTestHooks.detailUrlForConfirmation(
      'https://www.airbnb.com/api/v3/StayHostingDetailsQuery/hash?operationName=StayHostingDetailsQuery&locale=en&currency=USD&variables=%7B%22confirmationCode%22%3A%22HMOLD%22%2C%22requestSource%22%3A%22RESERVATION_LIST%22%2C%22viewerTimeZoneOffset%22%3A-240%2C%22reservationId%22%3A123%2C%22listingId%22%3A456%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22hash%22%7D%7D',
      'HMNEW123',
    );
    const parsedVariables = JSON.parse(new URL(url).searchParams.get('variables') ?? '{}');

    expect(parsedVariables).toEqual({
      confirmationCode: 'HMNEW123',
      requestSource: 'RESERVATION_LIST',
      viewerTimeZoneOffset: -240,
    });
  });

  it('only reuses the bootstrap response when its variables match the requested code', () => {
    const oldUrl =
      'https://www.airbnb.com/api/v3/StayHostingDetailsQuery/hash?operationName=StayHostingDetailsQuery&locale=en&currency=USD&variables=%7B%22confirmationCode%22%3A%22HMOLD123%22%2C%22requestSource%22%3A%22RESERVATION_LIST%22%7D';
    const requestedUrl =
      'https://www.airbnb.com/api/v3/StayHostingDetailsQuery/hash?operationName=StayHostingDetailsQuery&locale=en&currency=USD&variables=%7B%22confirmationCode%22%3A%22HMNEW123%22%2C%22requestSource%22%3A%22RESERVATION_LIST%22%7D';
    const oldCandidate = { sourceUrl: oldUrl, status: 200, value: { old: true }, requestHeaders: {} };
    const requestedCandidate = { sourceUrl: requestedUrl, status: 200, value: { requested: true }, requestHeaders: {} };

    expect(__reservationDetailScraperTestHooks.confirmationCodeFromDetailUrl(oldUrl)).toBe('HMOLD123');
    expect(
      __reservationDetailScraperTestHooks.selectBootstrapDetailCandidate(
        [oldCandidate, requestedCandidate],
        'hmnew123',
      ),
    ).toEqual({
      templateCandidate: requestedCandidate,
      reusableFirstCandidate: requestedCandidate,
    });
    expect(
      __reservationDetailScraperTestHooks.selectBootstrapDetailCandidate([oldCandidate], 'HMNEW123'),
    ).toEqual({
      templateCandidate: oldCandidate,
      reusableFirstCandidate: null,
    });
  });

  it('classifies auth and bad GraphQL request statuses as fatal, not missing details', () => {
    expect(__reservationDetailScraperTestHooks.isFatalDetailStatus(400)).toBe(true);
    expect(__reservationDetailScraperTestHooks.isFatalDetailStatus(401)).toBe(true);
    expect(__reservationDetailScraperTestHooks.isFatalDetailStatus(403)).toBe(true);
    expect(__reservationDetailScraperTestHooks.isFatalDetailStatus(404)).toBe(false);
    expect(__reservationDetailScraperTestHooks.isRetriableDetailStatus(429)).toBe(true);
    expect(__reservationDetailScraperTestHooks.isRetriableDetailStatus(500)).toBe(true);
    expect(__reservationDetailScraperTestHooks.isRetriableDetailStatus(404)).toBe(false);
  });

  it('extracts GraphQL error messages for per-reservation missing-detail handling', () => {
    expect(
      __reservationDetailScraperTestHooks.graphqlErrors({
        errors: [{ message: 'Reservation not found' }, { message: 'Access restricted' }],
      }),
    ).toBe('Reservation not found; Access restricted');
    expect(__reservationDetailScraperTestHooks.graphqlErrors(detailPayload())).toBeNull();
  });

  it('validates endpoint body limits and duplicate codes', () => {
    const { isValidBody } = __scrapeReservationDetailsEndpointTestHooks;
    expect(isValidBody({ host_id: 'h', confirmation_codes: ['HMABC123'] })).toBe(true);
    expect(isValidBody({ host_id: 'h', confirmation_codes: ['HMABCDEFG'] })).toBe(true);
    expect(isValidBody({ host_id: 'h', confirmation_codes: [] })).toBe(false);
    expect(isValidBody({ host_id: 'h', confirmation_codes: ['HMABC123', 'hmabc123'] })).toBe(false);
    expect(
      isValidBody({
        host_id: 'h',
        confirmation_codes: Array.from({ length: 26 }, (_, index) => `HMABC${index}123`),
      }),
    ).toBe(false);
  });

  it('classifies Airbnb detail API auth failures for endpoint reauth handling', () => {
    const { isAirbnbAuthFailure } = __scrapeReservationDetailsEndpointTestHooks;
    expect(isAirbnbAuthFailure(new Error('reservation_detail_api_failed:401'))).toBe(true);
    expect(isAirbnbAuthFailure(new Error('reservation_detail_api_failed:403'))).toBe(true);
    expect(isAirbnbAuthFailure(new Error('reservation_detail_api_failed:500'))).toBe(false);
  });
});
