package com.acme.core;

public class Money {
    private final String currency;
    private long cents;

    public Money(String currency, long cents) {
        this.currency = currency;
        this.cents = cents;
    }
}
