// Every test runs on the same fixed week, whatever the machine running it has
// configured. The environment wins over the settings table (see
// server/user-config.ts), so pinning these here also keeps the week out of
// whatever database a test happens to reach. user-config.test.ts clears them
// to test the real lookup.
process.env.SPRINTOMATIC_WORKING_DAYS = '0,1,2,3,4';
process.env.SPRINTOMATIC_WORKDAY_HOURS = '9';
process.env.SPRINTOMATIC_WORKDAY_START_HOUR = '8';
process.env.SPRINTOMATIC_WORKDAY_END_HOUR = '18';
process.env.SPRINTOMATIC_TENTATIVE_WEIGHT = '0';

// Never read or write the real Mac Keychain from a test (server/secrets.ts).
process.env.SPRINTOMATIC_KEYCHAIN = 'off';
