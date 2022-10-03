Multicurrency double-entry accounting module for NodeJS + Sequelize + Postgres
Inspired by [Medici](https://www.npmjs.com/package/medici)

# Install

`npm i fledger`

# Motivation

Medici lacks multicurrency support and runs on a slower Mongoose-MongoDB connection than Sequelize-Postgres. Besides, if your project uses only Postgres, it may be a hustle to raise another DB just to make use of Medici.

Fledger's API is similar to Medici, BUT IT DIFFERS ENOUGH!

# Basics

This readme doesn't cover double-ledger accounting basics, so you have to do your own research on how to use such systems and what are they for.

When you give Flanker a DB connection url (see Usage section), it turns this DB into a Book. Book is a collection of Journal Entries. Each Journal Entry is a set of Transactions on Accounts, that balance to zero. If you try to commit non-balanced entry, it will throw.

Each Transaction is an operation on exactly one Account - debit or credit.

Unlike Medici, Flanker uses a plan of accounts. That means that you have to create an Account before you can do Transactions on it.

Account names are arbitrary, but length of one account name can't be more than 255 chars, and it's full name (including parent accounts) cannot exceed 1024 chars. Names cannot contain semi-colon.

## Sub-accounts

Flanker utilizies a conception of sub-accounts, very common in accounting. Accounts are created as a tree (like folders in computer), and can be addressed with string semi-colon notation. For example: 'Assets' and 'Assets:bank', where the latter is sub-account of the former.

When you request balance or history of upper-level Account, you get aggregated balance of it AND all of it's sub-accounts. It allows you to query, for example, all expenses, or just office expenses, if you created a sub-account for it.  
For example, balance of `Assets:banks:Silvergate` is `5000` and balance of `Assets:banks:Huntington` is `10000`. You haven't created any transactions on `Assets` and `Assets:banks`.  
You call `book.balance('Assets')`, it returns `'15000'`

## Meta info

Every transaction can be augmented with meta-info. Meta-info is a JSON object. It's handy for filtering transactions.

For example, you have an account 'Assets:usdt', which reflects your USDT cryptowallet. There can be various types of transaction in and out of it. Augment every transaction with meta-info object like `{type: 'userDeposit'}` or `{type: 'innerFundsTransfer'}` so that you can later grab only user deposits out of all funds movements.

## Multi-currency

Multi-currency acconting requires that every time you post a Transaction on Account denominated in foreign currency, you augment it with current exchange rate to the *base accounting currency*. Even if you are to reflect the transfer of funds between two foreign currency accounts, their exchange rates should be to the base accounting currency, not between two of them foreign currencies.

First currency that you create in the currencies list is considered a base accounting currency. It's exchange rate always assumed to be `1.0`, no matter what you set in your transactions.

Exchange rate in Fledger is a **divisor**. It means that foreign currency is **divided by** exchange rate to obtain corresponding amount in base currency.

**Example:**

    // create currencies
    await book.createCurrency('USD'); // exchange rate always 1.0
    await book.createCurrency('THB')

    // create accounts
    await book.createAccount('USBank', 'USD')
    await book.createAccount('ThaiBank', 'THB')

    // create tx
    await book.entry('Reflect exchange of Thai Baht into USD')
      .credit('ThaiBank', 3000, null, 30.0)  // - tx over foreign currency account,
                                             //   have to put an exchange rate here
      .debit('USBank', 100)  // - tx over base currency account,
                             //   exchange rate is always 1.0
      .commit()

## Bignumber.js

Fledger uses `bignumber.js` under the hood to handle numbers. Transactions amounts in DB are held in BIGINT. Thats why all numbers returned by Fledger are Strings, not Numbers. This way we can guarantee stable handling of big numbers. You can convert them to Numbers at your own risk, but we suggest you use some big number library on your end, too. 

# Usage

## Require

    const postgresUriWithDb = 'postgres://user:password@postgres:5432/fledgerDB'
    const book = require('fledger')(postgresUriWithDb);

## Init

First time you import Fledger, it has to set up DB tables. For it to happen, call

    await book.init();

## Create Currencies

Create currencies that you're going to use.

**NB!:** first currency should be your base accounting currency! It's exchange rate always assumed to be `1.0`, no matter what you set in your transactions!

    await book.createCurrency('USD'); // base accounting currency
    await book.createCurrency('BTC'); // any other foreign (crypto)currency

## Create Accounts

To create root account:

    await book.createAccount('Assets', 'USD')

To create sub-account:

    await book.createAccount('usdt', 'USD', 'Assets')
    // parent account -----------------------^

To create sub-sub-account:

    // first create upper level accounts
    await book.createAccount('UserBalances', 'USD')
    await book.createAccount('1', 'USD', 'UserBalances')

    // create sub-sub-account 'UserBalances:1:spendable':
    await book.createAccount('spendable', 'USD', 'UserBalances:1') 
    // parent account ----------------------------^

## Create Journal Entries

This cute entry reflects user with id 1 deposited 10 dollars to our USDT wallet (debit), therefore we credited his account with 10 USD (credit).
Don't forget to `await .commit()`!

    await book.entry('User 1 deposit')
      .debit('Assets:usdt', 10, {type: 'userDeposit'})
      .credit('UserBalances:1:spendable', 10, {type: 'userDeposit'})
      .commit()
    
## Query balance

This query will return aggregated balance of 'Assets' account AND all it's subaccounts (like 'Assets:usdt' and so forth).

    await book.balance('Assets')
    // returns STRING!

Balances are cached in DB, so even if queried account has billions of records, balance is fast.

Balance query does not support meta filtering at the moment.

## Query Transactions history

This little ledger query will return sorted by date array of transactions of 'Assets' account AND all it's subaccounts, starting from month ago till now. Limit = 100. Order is 'DESC' (which is default) - newest first.

    await book.ledger(
      'Assets',
      { type: 'userDeposit' },
      {
        startDate: moment().subtract(1, 'month').toDate(),
        endDate: new Date(),
        offset: 0,            // pagination
        limit: 100,           // pagination
        order: 'DESC'         // newest first
      }
    )

Returned array is an array of RichTransaction objects:

    [
      {
        id: 1,
        accountName: 'Assets:usdt',
        accountPath: ['Assets', 'usdt'],
        amount: 10,
        credit: false,
        currency: 'USD',
        exchangeRate: 1.0,
        memo: 'User 1 deposit'
        meta: { type: 'userDeposit' }
        createdAt: <Date>
      },
      ...
    ]

## Close the book

When you're done accounting, it's good behaviour to

    await book.close();

# What's not done yet

- Transaction void. If you made a mistake, you'll have to manually commit an inverse Transaction
- Balance meta filtering. Not sure if needed.
- Moving Account to different parent
- ?

Will be happy to see your contributions and/or critics.