package com.acme.core;

import java.util.List;

public class Customer {
    private String name;
    private int age;
    private final String id;
    private final boolean active = true;
    private List<String> tags;
    private static int count;
    public static Builder builder() {
        return new Builder();
    }
    private Customer(Builder b) {
        this.name = b.name;
        this.id = b.id;
    }
    public static final class Builder {
        private String name;
        private String id;

        private Builder() {
        }

        public Builder setName(String name) {
            this.name = name;
            return this;
        }

        public Builder setId(String id) {
            this.id = id;
            return this;
        }

        public Customer build() {
            return new Customer(this);
        }
    }
}
