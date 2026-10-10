package com.acme.core;

public class Money {
    private final String currency;
    private long cents;

    public Money(String currency, long cents) {
        this.currency = currency;
        this.cents = cents;
    }

    public Money withCurrency(String currency) {
        return new Money(currency, this.cents);
    }

    public Money withCents(long cents) {
        return new Money(this.currency, cents);
    }
}
