package com.acme.core;

import java.util.List;

public class Customer {
    private String name;
    private int age;
    private final String id;
    private final boolean active = true;
    private List<String> tags;
    private static int count;
    private String email;
    public static Builder builder() {
        return new Builder();
    }
    private Customer(Builder b) {
        this.name = b.name;
        this.age = b.age;
        this.id = b.id;
        this.tags = b.tags;
        this.email = b.email;
    }
    public static final class Builder {
        private String name;
        private int age;
        private String id;
        private List<String> tags;
        private String email;

        private Builder() {
        }

        public Builder withName(String name) {
            this.name = name;
            return this;
        }

        public Builder withAge(int age) {
            this.age = age;
            return this;
        }

        public Builder withId(String id) {
            this.id = id;
            return this;
        }

        public Builder withTags(List<String> tags) {
            this.tags = tags;
            return this;
        }

        public Builder withEmail(String email) {
            this.email = email;
            return this;
        }

        public Customer build() {
            return new Customer(this);
        }
    }
}
